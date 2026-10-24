/**
 * G-263: browser-origin atomic graph checkpoints using IndexedDB readwrite
 * transactions. Two tabs using the SAME origin/database/object store serialize
 * get -> expected-head validation -> put; only one stale-head contender wins.
 *
 * This does not coordinate other storage providers, devices or servers. IDB
 * data can be evicted and is NOT an independent disaster-recovery backup.
 * An unknown transaction result must be reconciled by actionId, never retried
 * blindly. No external-world effects are replayed or undone.
 */
import {
  VersionStore,
  type CheckpointInput,
  type VersionDocument,
  type VersionRecord,
  type VersionStorage,
} from "./versionStore";

const STORE = "graphHistories";

function fail(code: string): never {
  throw new Error(code);
}

function valid(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function openDatabase(name: string): Promise<IDBDatabase> {
  if (!valid(name)) fail("INVALID_DATABASE_NAME");
  if (typeof indexedDB === "undefined") fail("INDEXEDDB_UNAVAILABLE");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(new Error("INDEXEDDB_OPEN_FAILED"));
    request.onblocked = () => reject(new Error("INDEXEDDB_OPEN_BLOCKED"));
  });
}

function storageFor(raw: string | null): {
  storage: VersionStorage;
  serialized: () => string | null;
} {
  let value = raw;
  return {
    storage: {
      getItem: () => value,
      setItem: (_key, next) => { value = next; },
    },
    serialized: () => value,
  };
}

/** Read and validate the entire graph DAG from a committed IDB transaction. */
export async function readIndexedDbHistory(
  databaseName: string,
  projectId: string,
): Promise<VersionDocument> {
  if (!valid(projectId)) fail("INVALID_PROJECT");
  const db = await openDatabase(databaseName);
  return new Promise((resolve, reject) => {
    let result: VersionDocument | null = null;
    let knownError: Error | null = null;
    try {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(projectId);
      request.onsuccess = () => {
        try {
          if (request.result !== undefined && typeof request.result !== "string") {
            fail("CORRUPT_HISTORY");
          }
          result = new VersionStore(
            storageFor(request.result ?? null).storage, projectId,
          ).load();
        } catch (error) {
          knownError = error as Error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        db.close();
        if (result) resolve(result);
        else reject(new Error("INDEXEDDB_READ_UNKNOWN"));
      };
      tx.onabort = () => {
        db.close();
        reject(knownError ?? new Error("INDEXEDDB_READ_UNKNOWN"));
      };
    } catch {
      db.close();
      reject(new Error("INDEXEDDB_READ_UNKNOWN"));
    }
  });
}

/**
 * Transactional expected-head and actionId checkpoint. The underlying
 * VersionStore validates the snapshot and rejects conflicting duplicate IDs.
 * Commit completion plus independent readback are required for success.
 */
export async function checkpointIndexedDb(
  databaseName: string,
  projectId: string,
  input: CheckpointInput,
): Promise<VersionRecord> {
  if (!valid(projectId)) fail("INVALID_PROJECT");
  const db = await openDatabase(databaseName);
  const committed = await new Promise<VersionRecord>((resolve, reject) => {
    let record: VersionRecord | null = null;
    let knownError: Error | null = null;
    try {
      const tx = db.transaction(STORE, "readwrite");
      const objectStore = tx.objectStore(STORE);
      const request = objectStore.get(projectId);
      request.onsuccess = () => {
        try {
          const previous = request.result;
          if (previous !== undefined && typeof previous !== "string") {
            fail("CORRUPT_HISTORY");
          }
          const memory = storageFor(previous ?? null);
          record = new VersionStore(memory.storage, projectId).checkpoint(input);
          const next = memory.serialized();
          if (next !== (previous ?? null)) objectStore.put(next, projectId);
        } catch (error) {
          knownError = error as Error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        db.close();
        if (record) resolve(record);
        else reject(new Error("INDEXEDDB_WRITE_UNKNOWN_RECONCILE_REQUIRED"));
      };
      tx.onabort = () => {
        db.close();
        reject(knownError ?? new Error("INDEXEDDB_WRITE_UNKNOWN_RECONCILE_REQUIRED"));
      };
    } catch {
      db.close();
      reject(new Error("INDEXEDDB_WRITE_UNKNOWN_RECONCILE_REQUIRED"));
    }
  });
  const reconciliation = await reconcileIndexedDbCheckpoint(
    databaseName, projectId, input,
  );
  if (reconciliation !== "APPLIED") {
    fail("INDEXEDDB_WRITE_UNKNOWN_RECONCILE_REQUIRED");
  }
  return committed;
}

/** Read-only exact action reconciliation after an ambiguous IDB result. */
export async function reconcileIndexedDbCheckpoint(
  databaseName: string,
  projectId: string,
  input: CheckpointInput,
): Promise<"APPLIED" | "NOT_APPLIED" | "CONFLICT"> {
  const history = await readIndexedDbHistory(databaseName, projectId);
  const found = history.versions.find((v) => v.actionId === input.actionId);
  if (!found) return "NOT_APPLIED";
  const exact = found.id === input.id &&
    found.parentId === input.expectedHeadId &&
    found.label === input.label &&
    found.createdAt === input.createdAt &&
    found.restoredFromId === input.restoredFromId &&
    JSON.stringify(found.snapshot) === JSON.stringify(input.snapshot);
  return exact ? "APPLIED" : "CONFLICT";
}
