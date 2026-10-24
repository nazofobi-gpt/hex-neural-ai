import { describe, expect, it } from "vitest";
import {
  VersionStore,
  type CheckpointInput,
  type VersionSnapshot,
  type VersionStorage,
} from "../src/versionStore";

class MemoryStorage implements VersionStorage {
  public readonly values = new Map<string, string>();
  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const snapshot = (label = "Input"): VersionSnapshot => ({
  nodes: [{ id: "hex-1", label, q: 0, r: 0 }],
  nextSequence: 2,
});
const input = (overrides: Partial<CheckpointInput> = {}): CheckpointInput => ({
  id: "v1",
  actionId: "action-1",
  expectedHeadId: null,
  label: "Initial",
  createdAt: "2026-10-24T02:00:00Z",
  snapshot: snapshot(),
  ...overrides,
});

describe("G-263 single-writer durable VersionStore", () => {
  it("persists a named graph checkpoint across store re-instantiation", () => {
    const storage = new MemoryStorage();
    const first = new VersionStore(storage, "project-A");
    expect(first.checkpoint(input()).parentId).toBeNull();
    const second = new VersionStore(storage, "project-A");
    expect(second.load()).toEqual({
      schemaVersion: 1,
      projectId: "project-A",
      headId: "v1",
      versions: [first.load().versions[0]],
    });
    expect(JSON.parse(second.exportJson()).versions).toHaveLength(1);
  });

  it("reconciles an exact repeated action without appending a duplicate", () => {
    const store = new VersionStore(new MemoryStorage(), "project-A");
    const first = store.checkpoint(input());
    expect(store.checkpoint(input())).toEqual(first);
    expect(store.load().versions).toHaveLength(1);
    expect(() => store.checkpoint(input({ label: "Different" }))).toThrow("ACTION_CONFLICT");
  });

  it("rejects stale expected heads and duplicate version identifiers", () => {
    const store = new VersionStore(new MemoryStorage(), "project-A");
    store.checkpoint(input());
    expect(() => store.checkpoint(input({
      id: "v2", actionId: "action-2", expectedHeadId: null,
    }))).toThrow("HEAD_CONFLICT");
    expect(() => store.checkpoint(input({
      id: "v1", actionId: "action-2", expectedHeadId: "v1",
    }))).toThrow("VERSION_ID_CONFLICT");
    expect(store.load().headId).toBe("v1");
  });

  it("restores by appending a new version without erasing the newer history", () => {
    const store = new VersionStore(new MemoryStorage(), "project-A");
    store.checkpoint(input());
    store.checkpoint(input({
      id: "v2", actionId: "action-2", expectedHeadId: "v1",
      label: "Moved", snapshot: snapshot("Changed"),
    }));
    const restored = store.restore({
      id: "v3", actionId: "action-3", expectedHeadId: "v2",
      label: "Restore v1", createdAt: "2026-10-24T02:03:00Z", targetId: "v1",
    });
    expect(restored.parentId).toBe("v2");
    expect(restored.restoredFromId).toBe("v1");
    expect(restored.snapshot).toEqual(snapshot());
    expect(store.load().versions.map((version) => version.id)).toEqual(["v1", "v2", "v3"]);
  });

  it("fails closed for corrupted history, mismatched project and malformed graph", () => {
    const storage = new MemoryStorage();
    const store = new VersionStore(storage, "project-A");
    storage.setItem(store.storageKey, "{not-json");
    expect(() => store.load()).toThrow("CORRUPT_HISTORY");
    storage.setItem(store.storageKey, JSON.stringify({
      schemaVersion: 1, projectId: "project-B", headId: null, versions: [],
    }));
    expect(() => store.load()).toThrow("CORRUPT_HISTORY");
    storage.values.delete(store.storageKey);
    expect(() => store.checkpoint(input({
      snapshot: { nodes: [
        { id: "hex-1", label: "A", q: 0, r: 0 },
        { id: "hex-1", label: "B", q: 1, r: 0 },
      ], nextSequence: 3 },
    }))).toThrow("INVALID_SNAPSHOT");
    expect(store.load().versions).toHaveLength(0);
  });

  it("treats an ambiguous write as UNKNOWN and requires readback reconciliation", () => {
    class WriteThenThrowStorage extends MemoryStorage {
      public override setItem(key: string, value: string): void {
        super.setItem(key, value);
        throw new Error("transport timeout after durable write");
      }
    }
    const storage = new WriteThenThrowStorage();
    const store = new VersionStore(storage, "project-A");
    expect(() => store.checkpoint(input())).toThrow("WRITE_UNKNOWN_RECONCILE_REQUIRED");
    const observed = store.load();
    expect(observed.headId).toBe("v1");
    expect(observed.versions[0].actionId).toBe("action-1");
    // Only after inspecting the persisted result may the caller classify it done.
    expect(store.checkpoint(input()).id).toBe("v1");
    expect(store.load().versions).toHaveLength(1);
  });

  it("returns detached snapshots and isolates projects sharing one storage", () => {
    const storage = new MemoryStorage();
    const a = new VersionStore(storage, "project-A");
    const b = new VersionStore(storage, "project-B");
    a.checkpoint(input());
    const detached = a.load();
    detached.versions[0].snapshot.nodes[0].label = "Tampered";
    expect(a.load().versions[0].snapshot.nodes[0].label).toBe("Input");
    expect(b.load().versions).toHaveLength(0);
  });

  it("rejects missing restore targets without mutating the version head", () => {
    const store = new VersionStore(new MemoryStorage(), "project-A");
    store.checkpoint(input());
    expect(() => store.restore({
      id: "v2", actionId: "action-2", expectedHeadId: "v1",
      label: "Missing", createdAt: "2026-10-24T02:02:00Z", targetId: "nope",
    })).toThrow("MISSING_RESTORE_TARGET");
    expect(store.load().headId).toBe("v1");
  });
});
