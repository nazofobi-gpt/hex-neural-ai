import { describe, expect, it } from "vitest";
import {
  exportVersionArchive,
  inspectVersionArchive,
  MAX_VERSION_ARCHIVE_BYTES,
} from "../src/versionArchive";
import { VersionStore, type VersionStorage } from "../src/versionStore";

class MemoryStorage implements VersionStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }
}

const checkpoint = {
  id: "v1",
  actionId: "action-1",
  expectedHeadId: null,
  label: "Initial",
  createdAt: "2026-10-24T05:30:00Z",
  snapshot: {
    nodes: [{ id: "hex-1", label: "Start", q: 0, r: 0 }],
    nextSequence: 2,
  },
};

function fixture() {
  const storage = new MemoryStorage();
  const store = new VersionStore(storage, "project-A");
  store.checkpoint(checkpoint);
  return { storage, store };
}

async function hash(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (x) =>
    x.toString(16).padStart(2, "0")).join("");
}

describe("G-263 portable version archive / recovery preflight", () => {
  it("round-trips a detached version history without writing to storage", async () => {
    const { store, storage } = fixture();
    const beforeWrites = storage.writes;
    const archive = await exportVersionArchive(store);
    expect(archive).toBe(await exportVersionArchive(store));
    const inspected = await inspectVersionArchive(archive, "project-A");
    expect(inspected).toEqual(store.load());
    inspected.versions[0].snapshot.nodes[0].label = "Not persisted";
    expect(store.load().versions[0].snapshot.nodes[0].label).toBe("Start");
    expect(storage.writes).toBe(beforeWrites);
  });

  it("rejects modified snapshot bytes even when JSON remains well formed", async () => {
    const { store } = fixture();
    const archive = JSON.parse(await exportVersionArchive(store));
    archive.document.versions[0].snapshot.nodes[0].label = "Tampered";
    await expect(inspectVersionArchive(JSON.stringify(archive), "project-A"))
      .rejects.toThrow("ARCHIVE_INTEGRITY_FAILURE");
  });

  it("rejects an archive for another project before any import", async () => {
    const { store } = fixture();
    await expect(inspectVersionArchive(
      await exportVersionArchive(store), "project-B",
    )).rejects.toThrow("ARCHIVE_PROJECT_MISMATCH");
  });

  it("rejects unsupported schema and invalid JSON", async () => {
    const { store } = fixture();
    const archive = JSON.parse(await exportVersionArchive(store));
    archive.format = "hex.versionArchive.v99";
    await expect(inspectVersionArchive(JSON.stringify(archive), "project-A"))
      .rejects.toThrow("INVALID_ARCHIVE");
    await expect(inspectVersionArchive("{", "project-A"))
      .rejects.toThrow("INVALID_ARCHIVE");
  });

  it("rejects a rehashed archive with a broken version DAG", async () => {
    const { store } = fixture();
    const archive = JSON.parse(await exportVersionArchive(store));
    archive.document.versions[0].parentId = "unknown-parent";
    archive.sha256 = await hash(JSON.stringify(archive.document));
    await expect(inspectVersionArchive(JSON.stringify(archive), "project-A"))
      .rejects.toThrow("CORRUPT_HISTORY");
  });

  it("enforces a strict byte cap before parsing untrusted input", async () => {
    await expect(inspectVersionArchive(
      "x".repeat(MAX_VERSION_ARCHIVE_BYTES + 1), "project-A",
    )).rejects.toThrow("ARCHIVE_TOO_LARGE");
  });

  it("does not allow an archive to authorize rollback or external effects", async () => {
    const { store } = fixture();
    const before = store.load();
    const inspected = await inspectVersionArchive(
      await exportVersionArchive(store), "project-A",
    );
    expect(inspected.headId).toBe("v1");
    expect(store.load()).toEqual(before);
    expect(store.load().versions).toHaveLength(1);
  });
});
