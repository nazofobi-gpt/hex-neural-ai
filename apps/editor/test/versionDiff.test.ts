import { describe, expect, it } from "vitest";
import { diffVersions } from "../src/versionDiff";
import {
  VersionStore,
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

const original: VersionSnapshot = {
  nodes: [
    { id: "alpha", label: "Input", q: 0, r: 0 },
    { id: "beta", label: "Evaluator", q: 1, r: 0 },
  ],
  nextSequence: 3,
};
const revised: VersionSnapshot = {
  nodes: [
    { id: "gamma", label: "Output", q: 2, r: 0 },
    { id: "alpha", label: "Renamed input", q: 0, r: 1 },
  ],
  nextSequence: 4,
};

function seeded(): { store: VersionStore; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const store = new VersionStore(storage, "project-diff");
  store.checkpoint({
    id: "v1", actionId: "save-1", expectedHeadId: null,
    label: "Before", createdAt: "2026-10-24T02:00:00Z", snapshot: original,
  });
  store.checkpoint({
    id: "v2", actionId: "save-2", expectedHeadId: "v1",
    label: "After", createdAt: "2026-10-24T02:01:00Z", snapshot: revised,
  });
  store.checkpoint({
    id: "v3", actionId: "save-3", expectedHeadId: "v2",
    label: "Same graph", createdAt: "2026-10-24T02:02:00Z", snapshot: revised,
  });
  return { store, storage };
}

describe("G-263 deterministic graph version diff", () => {
  it("classifies additions, removals, moves and renames without double-counting changed nodes", () => {
    const { store } = seeded();
    const diff = diffVersions(store, "v1", "v2");
    expect(diff.projectId).toBe("project-diff");
    expect(diff.summary).toEqual({
      added: 1, removed: 1, changed: 1, moved: 1, renamed: 1, unchanged: 0,
    });
    expect(diff.changes.map((change) => [change.id, change.kind])).toEqual([
      ["alpha", "changed"],
      ["beta", "removed"],
      ["gamma", "added"],
    ]);
    expect(diff.changes[0]).toMatchObject({
      kind: "changed", fields: ["position", "label"],
      before: { label: "Input", q: 0, r: 0 },
      after: { label: "Renamed input", q: 0, r: 1 },
    });
  });

  it("preserves direction and compares by stable ID rather than snapshot array order", () => {
    const { store } = seeded();
    const forward = diffVersions(store, "v1", "v2");
    const reverse = diffVersions(store, "v2", "v1");
    expect(reverse.summary).toEqual(forward.summary);
    expect(reverse.changes.find((change) => change.id === "beta")).toMatchObject({
      kind: "added", after: { label: "Evaluator" },
    });
    expect(reverse.changes.find((change) => change.id === "gamma")).toMatchObject({
      kind: "removed", before: { label: "Output" },
    });
    expect(reverse.changes[0]).toMatchObject({
      kind: "changed", before: { q: 0, r: 1 }, after: { q: 0, r: 0 },
    });
  });

  it("returns no changes for equivalent checkpoints and for self comparison", () => {
    const { store } = seeded();
    for (const [from, to] of [["v2", "v3"], ["v1", "v1"]]) {
      const diff = diffVersions(store, from, to);
      expect(diff.changes).toEqual([]);
      expect(diff.summary.changed).toBe(0);
      expect(diff.summary.unchanged).toBe(2);
    }
  });

  it("rejects a missing version without changing history", () => {
    const { store } = seeded();
    const before = store.exportJson();
    expect(() => diffVersions(store, "v1", "not-a-version")).toThrow("MISSING_VERSION");
    expect(store.exportJson()).toBe(before);
  });

  it("fails closed on corrupted stored history and never fabricates a diff", () => {
    const { store, storage } = seeded();
    storage.setItem(store.storageKey, "{corrupt");
    expect(() => diffVersions(store, "v1", "v2")).toThrow("CORRUPT_HISTORY");
  });

  it("returns detached node data and does not mutate the source history", () => {
    const { store } = seeded();
    const before = store.exportJson();
    const diff = diffVersions(store, "v1", "v2");
    const added = diff.changes.find((change) => change.kind === "added");
    if (!added || added.kind !== "added") throw new Error("Missing added node");
    added.after.label = "Tampered";
    expect(store.exportJson()).toBe(before);
    expect(diffVersions(store, "v1", "v2").changes).toEqual(
      diffVersions(store, "v1", "v2").changes,
    );
    expect(store.load().versions[1].snapshot.nodes[0].label).toBe("Output");
  });
});
