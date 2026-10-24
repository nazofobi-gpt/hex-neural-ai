/**
 * G-263: preflight an archived-HEAD restore in an isolated, disposable store.
 *
 * This checks archive integrity, backup readback, restore preconditions and
 * action reconciliation WITHOUT touching the caller's real project storage.
 * It is a simulation, not proof of external backup durability, multiwriter CAS,
 * RPO/RTO, UI integration or rollback of external tool effects.
 */
import { inspectVersionArchive } from "./versionArchive";
import {
  prepareArchivedHeadRecovery,
  reconcileArchivedHeadRecovery,
  type ArchivedHeadCheckpoint,
} from "./versionArchiveRecovery";
import {
  applyArchivedHeadRecoveryWithBackup,
  persistRecoveryBackup,
  reconcileRecoveryBackup,
  type RecoveryBackupRepository,
} from "./versionRecoveryBackup";
import { VersionStore, type VersionStorage } from "./versionStore";

class IsolatedVersionStorage implements VersionStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class IsolatedBackupRepository implements RecoveryBackupRepository {
  private readonly data = new Map<string, string>();
  read(backupId: string): string | null {
    return this.data.get(backupId) ?? null;
  }
  write(backupId: string, receipt: string): void {
    if (this.data.has(backupId)) throw new Error("DRILL_BACKUP_CONFLICT");
    this.data.set(backupId, receipt);
  }
}

export interface IsolatedRecoveryDrillReceipt {
  format: "hex.isolatedRecoveryDrill.v1";
  mode: "ISOLATED_SIMULATION_ONLY";
  projectId: string;
  sourceHeadId: string;
  previousHeadId: string | null;
  simulatedHeadId: string;
  previousVersionCount: number;
  simulatedVersionCount: number;
  backupReadback: "EPHEMERAL_VERIFIED_ONLY";
  actionReconciliation: "APPLIED";
}

/**
 * Validates both archives and performs the proposed restore on an independent
 * in-memory clone. A PASS is only permission to consider a separately approved
 * real restore after durable backup, writer ownership and consent checks.
 */
export async function runIsolatedRecoveryDrill(
  projectId: string,
  localArchive: string,
  sourceArchive: string,
  checkpoint: ArchivedHeadCheckpoint,
  backupId: string,
): Promise<IsolatedRecoveryDrillReceipt> {
  const before = await inspectVersionArchive(localArchive, projectId);
  const source = await inspectVersionArchive(sourceArchive, projectId);
  if (!source.headId) throw new Error("DRILL_SOURCE_EMPTY");

  const isolatedStorage = new IsolatedVersionStorage();
  const store = new VersionStore(isolatedStorage, projectId);
  isolatedStorage.setItem(store.storageKey, JSON.stringify(before));
  const plan = await prepareArchivedHeadRecovery(store, sourceArchive);
  if (plan.expectedHeadId !== before.headId ||
      plan.sourceHeadId !== source.headId) {
    throw new Error("DRILL_PLAN_MISMATCH");
  }

  const repository = new IsolatedBackupRepository();
  await persistRecoveryBackup(repository, backupId, plan);
  if (await reconcileRecoveryBackup(repository, backupId, plan) !== "VERIFIED") {
    throw new Error("DRILL_BACKUP_NOT_VERIFIED");
  }

  const restored = await applyArchivedHeadRecoveryWithBackup(
    store, plan, checkpoint, repository, backupId,
  );
  const after = store.load();
  const sourceHead = source.versions[source.versions.length - 1];
  if (!sourceHead ||
      JSON.stringify(restored.snapshot) !== JSON.stringify(sourceHead.snapshot) ||
      after.headId !== restored.id ||
      after.versions.length !== before.versions.length + 1 ||
      JSON.stringify(after.versions.slice(0, -1)) !== JSON.stringify(before.versions)) {
    throw new Error("DRILL_RESTORE_MISMATCH");
  }
  if (await reconcileArchivedHeadRecovery(store, plan, checkpoint) !== "APPLIED") {
    throw new Error("DRILL_ACTION_NOT_RECONCILED");
  }

  return {
    format: "hex.isolatedRecoveryDrill.v1",
    mode: "ISOLATED_SIMULATION_ONLY",
    projectId,
    sourceHeadId: source.headId,
    previousHeadId: before.headId,
    simulatedHeadId: restored.id,
    previousVersionCount: before.versions.length,
    simulatedVersionCount: after.versions.length,
    backupReadback: "EPHEMERAL_VERIFIED_ONLY",
    actionReconciliation: "APPLIED",
  };
}
