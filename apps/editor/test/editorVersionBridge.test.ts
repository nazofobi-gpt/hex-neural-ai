import { describe, expect, it } from "vitest";
import { EditorState } from "../src/editorState";
import {
  checkpointEditor,
  compareEditorVersions,
  restoreEditor,
} from "../src/editorVersionBridge";
import { VersionStore, type VersionStorage } from "../src/versionStore";

class MemoryStorage implements VersionStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const at = "2026-10-24T04:30:00Z";
const graph = () => new EditorState([{ id: "hex-1", label: "Start", q: 0, r: 0 }]);
const v1 = { id: "v1", actionId: "action-1", expectedHeadId: null, label: "Initial", createdAt: at };
const v2 = { id: "v2", actionId: "action-2", expectedHeadId: "v1", label: "Moved", createdAt: at };

describe("G-263 EditorState / VersionStore integration", () => {
  it("saves actual editor graph and isolates persisted snapshots from later edits", () => {
    const store = new VersionStore(new MemoryStorage(), "project-A");
    const editor = graph();
    expect(checkpointEditor(store, editor, v1).snapshot.nodes[0].label).toBe("Start");
    expect(editor.move("hex-1", { q: 1, r: 0 })).toBe(true);
    expect(store.load().versions[0].snapshot.nodes[0]).toMatchObject({ q: 0, r: 0 });
    expect(checkpointEditor(store, editor, v2).snapshot.nodes[0]).toMatchObject({ q: 1, r: 0 });
    expect(store.load().versions).toHaveLength(2);
  });

  it("diffs two named graphs and restores by appending without replaying stale undo", () => {
    const store = new VersionStore(new MemoryStorage(), "project-A");
    const editor = graph();
    checkpointEditor(store, editor, v1);
    editor.move("hex-1", { q: 1, r: 0 });
    checkpointEditor(store, editor, v2);
    expect(compareEditorVersions(store, "v1", "v2").summary.moved).toBe(1);
    const restored = restoreEditor(store, editor, {
      id: "v3", actionId: "action-3", expectedHeadId: "v2",
      label: "Restore Initial", createdAt: at, targetId: "v1",
    });
    expect(restored.restoredFromId).toBe("v1");
    expect(store.load().versions.map((x) => x.id)).toEqual(["v1", "v2", "v3"]);
    expect(editor.nodes[0]).toMatchObject({ q: 0, r: 0 });
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(false);
    expect(editor.addAt({ q: 1, r: 0 })?.id).toBe("hex-2");
  });

  it("rejects stale restore heads without changing the displayed graph", () => {
    const store = new VersionStore(new MemoryStorage(), "project-A");
    const editor = graph();
    checkpointEditor(store, editor, v1);
    editor.move("hex-1", { q: 1, r: 0 });
    checkpointEditor(store, editor, v2);
    const before = editor.exportVersionSnapshot();
    expect(() => restoreEditor(store, editor, {
      id: "v3", actionId: "action-3", expectedHeadId: "v1",
      label: "Stale", createdAt: at, targetId: "v1",
    })).toThrow("HEAD_CONFLICT");
    expect(editor.exportVersionSnapshot()).toEqual(before);
    expect(store.load().versions).toHaveLength(2);
  });

  it("rejects malformed restored graph before any durable restore write", () => {
    const store = new VersionStore(new MemoryStorage(), "project-A");
    const editor = graph();
    store.checkpoint({
      ...v1,
      snapshot: { nodes: [{ id: "hex-1", label: "Bad", q: 0, r: 0 }], nextSequence: 1 },
    });
    const before = editor.exportVersionSnapshot();
    expect(() => restoreEditor(store, editor, {
      id: "v2", actionId: "action-2", expectedHeadId: "v1",
      label: "Unsafe", createdAt: at, targetId: "v1",
    })).toThrow("INVALID_VERSION_SNAPSHOT");
    expect(editor.exportVersionSnapshot()).toEqual(before);
    expect(store.load().versions).toHaveLength(1);
  });

  it("validates all graph nodes atomically before applying a snapshot", () => {
    const editor = graph();
    const before = editor.exportVersionSnapshot();
    expect(() => editor.applyVersionSnapshot({
      nodes: [
        { id: "hex-1", label: "A", q: 0, r: 0 },
        { id: "hex-2", label: "B", q: 0, r: 0 },
      ], nextSequence: 3,
    })).toThrow("INVALID_VERSION_SNAPSHOT");
    expect(editor.exportVersionSnapshot()).toEqual(before);
    const detached = editor.exportVersionSnapshot();
    detached.nodes[0].label = "Mutated";
    expect(editor.nodes[0].label).toBe("Start");
  });

  it("leaves editor untouched on an ambiguous durable checkpoint write", () => {
    class WriteThenThrow extends MemoryStorage {
      override setItem(key: string, value: string): void {
        super.setItem(key, value);
        throw new Error("unknown transport outcome");
      }
    }
    const store = new VersionStore(new WriteThenThrow(), "project-A");
    const editor = graph();
    const before = editor.exportVersionSnapshot();
    expect(() => checkpointEditor(store, editor, v1)).toThrow("WRITE_UNKNOWN_RECONCILE_REQUIRED");
    expect(editor.exportVersionSnapshot()).toEqual(before);
    expect(store.load().versions[0].actionId).toBe("action-1");
  });
});
