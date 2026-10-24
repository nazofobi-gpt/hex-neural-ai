/**
 * G-263 / VER graph diff: deterministic, read-only comparison of two named
 * checkpoints already validated by VersionStore.load().
 *
 * A diff is descriptive only: it never replays, rolls back, or authorizes
 * external side effects. "changed" counts nodes, while "moved" and
 * "renamed" are overlapping attributes of those nodes.
 */
import { VersionStore, type VersionNode } from "./versionStore";

export type VersionNodeChange =
  | { kind: "added"; id: string; after: VersionNode }
  | { kind: "removed"; id: string; before: VersionNode }
  | {
      kind: "changed";
      id: string;
      before: VersionNode;
      after: VersionNode;
      fields: ("position" | "label")[];
    };

export interface VersionDiff {
  projectId: string;
  fromId: string;
  toId: string;
  changes: VersionNodeChange[];
  summary: {
    added: number;
    removed: number;
    changed: number;
    moved: number;
    renamed: number;
    unchanged: number;
  };
}

function copy(node: VersionNode): VersionNode {
  return { id: node.id, label: node.label, q: node.q, r: node.r };
}

/**
 * Compare immutable history records by their exact IDs, not array position.
 * The store validates history, graph uniqueness, and project identity before
 * any result is returned. Sorting by node ID makes results stable across runs.
 */
export function diffVersions(
  store: VersionStore,
  fromId: string,
  toId: string,
): VersionDiff {
  const history = store.load();
  const from = history.versions.find((record) => record.id === fromId);
  const to = history.versions.find((record) => record.id === toId);
  if (!from || !to) throw new Error("MISSING_VERSION");

  const oldNodes = new Map(from.snapshot.nodes.map((node) => [node.id, node]));
  const newNodes = new Map(to.snapshot.nodes.map((node) => [node.id, node]));
  const ids = [...new Set([...oldNodes.keys(), ...newNodes.keys()])].sort();
  const changes: VersionNodeChange[] = [];
  const summary = {
    added: 0,
    removed: 0,
    changed: 0,
    moved: 0,
    renamed: 0,
    unchanged: 0,
  };

  for (const id of ids) {
    const before = oldNodes.get(id);
    const after = newNodes.get(id);
    if (!before && after) {
      changes.push({ kind: "added", id, after: copy(after) });
      summary.added += 1;
    } else if (before && !after) {
      changes.push({ kind: "removed", id, before: copy(before) });
      summary.removed += 1;
    } else if (before && after) {
      const fields: ("position" | "label")[] = [];
      if (before.q !== after.q || before.r !== after.r) {
        fields.push("position");
        summary.moved += 1;
      }
      if (before.label !== after.label) {
        fields.push("label");
        summary.renamed += 1;
      }
      if (fields.length) {
        changes.push({
          kind: "changed", id,
          before: copy(before), after: copy(after), fields,
        });
        summary.changed += 1;
      } else {
        summary.unchanged += 1;
      }
    }
  }

  return {
    projectId: history.projectId,
    fromId,
    toId,
    changes,
    summary,
  };
}
