/**
 * G-263: opt-in, single-writer recovery of an archived graph HEAD.
 *
 * Preparation is read-only and returns an exact pre-mutation backup bundle.
 * The caller MUST durably retain that backup and serialize project writers
 * before applying. This adapter has no provider-atomic cross-tab/process CAS.
 *
 * Import appends one NEW local checkpoint. It does not overwrite history,
 * import foreign action IDs, replay tool calls, or undo external side effects.
 * An UNKNOWN write must be reconciled by actionId; never blindly retry it.
 */
import {
  exportVersionArchive,
  inspectVersionArchive,
} from "./versionArchive";
import {
  VersionStore,
  type CheckpointInput,
  type VersionRecord,
} from "./versionStore";

export type ArchivedHeadCheckpoint = Omit<
  CheckpointInput, "snapshot" | "restoredFromId"
>;

export interface ArchivedHeadRecoveryPlan {
  readonly projectId: string;
  readonly expectedHeadId: string | null;
  readonly sourceHeadId: string;
  readonly sourceArchive: string;
  readonly backupArchive: string;
}

function fail(code: string): never {
  throw new Error(code);
}

/** Inspect the untrusted archive and capture a complete local backup first. */
export async function prepareArchivedHeadRecovery(
  store: VersionStore,
  sourceArchive: string,
): Promise<ArchivedHeadRecoveryPlan> {
  const before = store.load();
  const source = await inspectVersionArchive(sourceArchive, before.projectId);
  if (!source.headId) fail("ARCHIVE_EMPTY");
  const backupArchive = await exportVersionArchive(store);
  if (JSON.stringify(store.load()) !== JSON.stringify(before)) {
    fail("RECOVERY_PLAN_STALE");
  }
  return {
    projectId: before.projectId,
    expectedHeadId: before.headId,
    sourceHeadId: source.headId,
    sourceArchive,
    backupArchive,
  };
}

/**
 * Append the archived HEAD as a new local checkpoint after the caller has
 * durably saved plan.backupArchive. The source's version IDs are NOT grafted
 * into the local DAG; restoredFromId is intentionally not used.
 *
 * If persistence reports UNKNOWN, call reconcileArchivedHeadRecovery and
 * stop. Do not call this function again without a separate recovery decision.
 */
export async function applyArchivedHeadRecovery(
  store: VersionStore,
  plan: ArchivedHeadRecoveryPlan,
  input: ArchivedHeadCheckpoint,
): Promise<VersionRecord> {
  const current = store.load();
  if (current.projectId !== plan.projectId) fail("RECOVERY_PROJECT_MISMATCH");
  if (current.versions.some((version) => version.actionId === input.actionId)) {
    fail("RECOVERY_RECONCILE_REQUIRED");
  }
  if (current.headId !== plan.expectedHeadId ||
      input.expectedHeadId !== plan.expectedHeadId) {
    fail("RECOVERY_HEAD_CONFLICT");
  }
  if (await exportVersionArchive(store) !== plan.backupArchive) {
    fail("RECOVERY_BACKUP_CHANGED");
  }
  const source = await inspectVersionArchive(plan.sourceArchive, current.projectId);
  if (source.headId !== plan.sourceHeadId || !source.headId) {
    fail("RECOVERY_SOURCE_CHANGED");
  }
  const archivedHead = source.versions[source.versions.length - 1];
  if (!archivedHead || archivedHead.id !== source.headId) {
    fail("RECOVERY_SOURCE_CHANGED");
  }
  return store.checkpoint({ ...input, snapshot: archivedHead.snapshot });
}

/**
 * Read-only reconciliation after an UNKNOWN/ambiguous storage write.
 * APPLIED means the exact action metadata AND archived snapshot were found.
 * NOT_APPLIED is not permission to retry; caller must recheck ownership.
 */
export async function reconcileArchivedHeadRecovery(
  store: VersionStore,
  plan: ArchivedHeadRecoveryPlan,
  input: ArchivedHeadCheckpoint,
): Promise<"APPLIED" | "NOT_APPLIED" | "CONFLICT"> {
  const current = store.load();
  if (current.projectId !== plan.projectId) fail("RECOVERY_PROJECT_MISMATCH");
  const matching = current.versions.find(
    (version) => version.actionId === input.actionId,
  );
  if (!matching) return "NOT_APPLIED";
  const source = await inspectVersionArchive(plan.sourceArchive, plan.projectId);
  const archivedHead = source.versions[source.versions.length - 1];
  const exact = source.headId === plan.sourceHeadId &&
    archivedHead?.id === plan.sourceHeadId &&
    matching.id === input.id &&
    matching.parentId === plan.expectedHeadId &&
    matching.label === input.label &&
    matching.createdAt === input.createdAt &&
    matching.restoredFromId === undefined &&
    JSON.stringify(matching.snapshot) === JSON.stringify(archivedHead.snapshot);
  return exact ? "APPLIED" : "CONFLICT";
}
