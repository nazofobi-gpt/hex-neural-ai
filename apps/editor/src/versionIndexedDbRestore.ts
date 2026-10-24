/**
 * G-263: append-only browser IndexedDB graph restore, guarded by the same
 * transaction-level expected-HEAD check used for ordinary checkpoints.
 *
 * Reading the target snapshot is not a lease. A competing tab can advance
 * HEAD before the write; checkpointIndexedDb then fails with HEAD_CONFLICT.
 * Never replay external tool calls or claim a restored snapshot undoes them.
 * Browser IDB is not an independent backup or cross-device CAS service.
 */
import type { CheckpointInput, VersionDocument, VersionRecord } from "./versionStore";
import {
  checkpointIndexedDb,
  readIndexedDbHistory,
  reconcileIndexedDbCheckpoint,
} from "./versionIndexedDb";

export interface IndexedDbRestoreInput
  extends Omit<CheckpointInput, "snapshot" | "restoredFromId"> {
  targetId: string;
}

function asCheckpoint(
  history: VersionDocument,
  input: IndexedDbRestoreInput,
): CheckpointInput {
  const target = history.versions.find((entry) => entry.id === input.targetId);
  if (!target) throw new Error("MISSING_RESTORE_TARGET");
  return {
    id: input.id,
    actionId: input.actionId,
    expectedHeadId: input.expectedHeadId,
    label: input.label,
    createdAt: input.createdAt,
    snapshot: target.snapshot,
    restoredFromId: target.id,
  };
}

/**
 * Restore an existing project version by appending a new checkpoint. The
 * checkpoint's atomic IDB transaction rechecks HEAD and actionId after the
 * read-only target lookup. A stale contender cannot overwrite the winner.
 */
export async function restoreIndexedDbVersion(
  databaseName: string,
  projectId: string,
  input: IndexedDbRestoreInput,
): Promise<VersionRecord> {
  const history = await readIndexedDbHistory(databaseName, projectId);
  return checkpointIndexedDb(
    databaseName,
    projectId,
    asCheckpoint(history, input),
  );
}

/**
 * Read-only reconciliation after an ambiguous restore result. NOT_APPLIED
 * does not authorize a blind retry: the caller must recheck ownership.
 */
export async function reconcileIndexedDbRestore(
  databaseName: string,
  projectId: string,
  input: IndexedDbRestoreInput,
): Promise<"APPLIED" | "NOT_APPLIED" | "CONFLICT"> {
  const history = await readIndexedDbHistory(databaseName, projectId);
  return reconcileIndexedDbCheckpoint(
    databaseName,
    projectId,
    asCheckpoint(history, input),
  );
}
