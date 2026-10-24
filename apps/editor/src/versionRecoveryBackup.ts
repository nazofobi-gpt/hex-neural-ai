/**
 * G-263: explicit backup-readback gate for archived graph recovery.
 *
 * The caller MUST supply an independently durable backup repository and
 * serialize writers before using this module. This synchronous interface
 * cannot prove crash durability, cross-tab CAS, or remote retention.
 *
 * An ambiguous backup write is UNKNOWN: reconcile by backupId, never blindly
 * retry. Recovery appends a graph checkpoint, not external-world undo.
 */
import { inspectVersionArchive } from "./versionArchive";
import {
  applyArchivedHeadRecovery,
  type ArchivedHeadCheckpoint,
  type ArchivedHeadRecoveryPlan,
} from "./versionArchiveRecovery";
import { VersionStore, type VersionRecord } from "./versionStore";

export interface RecoveryBackupRepository {
  read(backupId: string): string | null;
  write(backupId: string, serializedReceipt: string): void;
}

export interface RecoveryBackupReceipt {
  format: "hex.recoveryBackup.v1";
  backupId: string;
  projectId: string;
  expectedHeadId: string | null;
  sourceHeadId: string;
  backupArchive: string;
  sourceArchive: string;
}

export type BackupReconciliation = "VERIFIED" | "MISSING" | "CONFLICT";

function fail(code: string): never {
  throw new Error(code);
}

function expectedReceipt(
  backupId: string,
  plan: ArchivedHeadRecoveryPlan,
): RecoveryBackupReceipt {
  if (typeof backupId !== "string" || !backupId.trim() ||
      backupId.length > 256) fail("INVALID_BACKUP_ID");
  return {
    format: "hex.recoveryBackup.v1",
    backupId,
    projectId: plan.projectId,
    expectedHeadId: plan.expectedHeadId,
    sourceHeadId: plan.sourceHeadId,
    backupArchive: plan.backupArchive,
    sourceArchive: plan.sourceArchive,
  };
}

async function validatePlan(plan: ArchivedHeadRecoveryPlan): Promise<void> {
  const [backup, source] = await Promise.all([
    inspectVersionArchive(plan.backupArchive, plan.projectId),
    inspectVersionArchive(plan.sourceArchive, plan.projectId),
  ]);
  if (backup.headId !== plan.expectedHeadId ||
      source.headId !== plan.sourceHeadId || !source.headId) {
    fail("BACKUP_PLAN_MISMATCH");
  }
}

function readBackup(
  repository: RecoveryBackupRepository,
  backupId: string,
): string | null {
  try {
    return repository.read(backupId);
  } catch {
    return fail("BACKUP_READ_UNKNOWN");
  }
}

/**
 * Read-only reconciliation after a successful or ambiguous backup write.
 * VERIFIED proves exact serialized readback and valid archive integrity;
 * the adapter's external durability guarantee must be assessed separately.
 */
export async function reconcileRecoveryBackup(
  repository: RecoveryBackupRepository,
  backupId: string,
  plan: ArchivedHeadRecoveryPlan,
): Promise<BackupReconciliation> {
  const expected = JSON.stringify(expectedReceipt(backupId, plan));
  const existing = readBackup(repository, backupId);
  if (existing === null) return "MISSING";
  if (existing !== expected) return "CONFLICT";
  await validatePlan(plan);
  return "VERIFIED";
}

/**
 * Persist a complete, immutable recovery backup receipt BEFORE graph restore.
 * Same backupId+payload is idempotent; different content is a hard conflict.
 * No blind retry on UNKNOWN; caller must reconcile before deciding next step.
 */
export async function persistRecoveryBackup(
  repository: RecoveryBackupRepository,
  backupId: string,
  plan: ArchivedHeadRecoveryPlan,
): Promise<RecoveryBackupReceipt> {
  const receipt = expectedReceipt(backupId, plan);
  await validatePlan(plan);
  const serialized = JSON.stringify(receipt);
  const existing = readBackup(repository, backupId);
  if (existing !== null) {
    if (existing !== serialized) fail("BACKUP_CONFLICT");
    return receipt;
  }
  try {
    repository.write(backupId, serialized);
    if (repository.read(backupId) !== serialized) {
      fail("BACKUP_WRITE_UNKNOWN_RECONCILE_REQUIRED");
    }
  } catch {
    fail("BACKUP_WRITE_UNKNOWN_RECONCILE_REQUIRED");
  }
  return receipt;
}

/**
 * Fail closed unless the backup has exact readback. This is NOT a distributed
 * lock: callers still need independent writer serialization and user consent.
 */
export async function applyArchivedHeadRecoveryWithBackup(
  store: VersionStore,
  plan: ArchivedHeadRecoveryPlan,
  input: ArchivedHeadCheckpoint,
  repository: RecoveryBackupRepository,
  backupId: string,
): Promise<VersionRecord> {
  if (await reconcileRecoveryBackup(repository, backupId, plan) !== "VERIFIED") {
    fail("BACKUP_NOT_VERIFIED");
  }
  return applyArchivedHeadRecovery(store, plan, input);
}
