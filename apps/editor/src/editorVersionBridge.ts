/**
 * G-263: task-local, single-writer bridge between the live EditorState graph
 * and durable project-scoped VersionStore records.
 *
 * Caller owns project identity, stable action IDs and writer serialization.
 * This does NOT provide cross-tab CAS or undo external-world side effects.
 */
import { EditorState } from "./editorState";
import { diffVersions, type VersionDiff } from "./versionDiff";
import {
  VersionStore,
  type CheckpointInput,
  type VersionRecord,
} from "./versionStore";

export type EditorCheckpointInput = Omit<CheckpointInput, "snapshot">;
export type EditorRestoreInput = Omit<CheckpointInput, "snapshot" | "restoredFromId"> & {
  targetId: string;
};

/** Persist exactly the graph currently displayed by the editor. */
export function checkpointEditor(
  store: VersionStore,
  editor: EditorState,
  input: EditorCheckpointInput,
): VersionRecord {
  return store.checkpoint({ ...input, snapshot: editor.exportVersionSnapshot() });
}

/**
 * Restore a named version by appending a new immutable checkpoint.
 * Validate the saved graph BEFORE writing; only replace the visible editor
 * after VersionStore has confirmed persistence/readback. An UNKNOWN write
 * leaves the visible graph untouched until the caller reconciles actionId.
 */
export function restoreEditor(
  store: VersionStore,
  editor: EditorState,
  input: EditorRestoreInput,
): VersionRecord {
  const target = store.load().versions.find((record) => record.id === input.targetId);
  if (!target) throw new Error("MISSING_RESTORE_TARGET");
  const probe = new EditorState([]);
  probe.applyVersionSnapshot(target.snapshot);
  const restored = store.restore(input);
  editor.applyVersionSnapshot(restored.snapshot);
  return restored;
}

/** Compare two named snapshots without changing editor or external state. */
export function compareEditorVersions(
  store: VersionStore,
  fromId: string,
  toId: string,
): VersionDiff {
  return diffVersions(store, fromId, toId);
}
