import { describe, expect, it } from "vitest";
import { exportVersionArchive } from "../src/versionArchive";
import {
  prepareArchivedHeadRecovery,
  type ArchivedHeadRecoveryPlan,
} from "../src/versionArchiveRecovery";
import {
  applyArchivedHeadRecoveryWithBackup,
  persistRecoveryBackup,
  reconcileRecoveryBackup,
  type RecoveryBackupRepository,
} from "../src/versionRecoveryBackup";
import { VersionStore, type VersionStorage } from "../src/versionStore";

class MemoryStorage implements VersionStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class BackupRepository implements RecoveryBackupRepository {
  readonly data = new Map<string, string>();
  writes = 0;
  throwAfterWrite = false;
  readFails = false;
  read(key: string): string | null {
    if (this.readFails) throw new Error("backup unavailable");
    return this.data.get(key) ?? null;
  }
  write(key: string, value: string): void {
    this.writes += 1;
    this.data.set(key, value);
    if (this.throwAfterWrite) throw new Error("ambiguous backup write");
  }
}

const initial = {
  id: "local-v1",
  actionId: "local-action-1",
  expectedHeadId: null,
  label: "Local initial",
  createdAt: "2026-10-24T07:00:00Z",
  snapshot: {
    nodes: [{ id: "local-node", label: "Local", q: 0, r: 0 }],
    nextSequence: 2,
  },
};
const archived = {
  id: "remote-v1",
  actionId: "remote-action-1",
  expectedHeadId: null,
  label: "Archived initial",
  createdAt: "2026-10-24T07:01:00Z",
  snapshot: {
    nodes: [{ id: "remote-node", label: "Remote", q: 3, r: -1 }],
    nextSequence: 2,
  },
};
const restoreInput = {
  id: "local-v2",
  actionId: "restore-action-1",
  expectedHeadId: "local-v1",
  label: "Restore archived graph",
  createdAt: "2026-10-24T07:02:00Z",
};

async function fixture() {
  const local = new VersionStore(new MemoryStorage(), "project-A");
  local.checkpoint(initial);
  const source = new VersionStore(new MemoryStorage(), "project-A");
  source.checkpoint(archived);
  const plan = await prepareArchivedHeadRecovery(
    local, await exportVersionArchive(source),
  );
  const repository = new BackupRepository();
  return { local, source, plan, repository };
}

describe("G-263 explicit archived recovery backup gate", () => {
  it("requires exact backup readback before appending a recovery checkpoint", async () => {
    const { local, source, plan, repository } = await fixture();
    const before = local.load();
    await expect(applyArchivedHeadRecoveryWithBackup(
      local, plan, restoreInput, repository, "backup-1",
    )).rejects.toThrow("BACKUP_NOT_VERIFIED");
    expect(local.load()).toEqual(before);
    const receipt = await persistRecoveryBackup(repository, "backup-1", plan);
    expect(receipt.backupArchive).toBe(plan.backupArchive);
    expect(await reconcileRecoveryBackup(repository, "backup-1", plan))
      .toBe("VERIFIED");
    const record = await applyArchivedHeadRecoveryWithBackup(
      local, plan, restoreInput, repository, "backup-1",
    );
    expect(record.snapshot).toEqual(source.load().versions[0].snapshot);
    expect(local.load().versions.map((v) => v.id)).toEqual([
      "local-v1", "local-v2",
    ]);
    expect(repository.data.get("backup-1")).toBe(JSON.stringify(receipt));
  });

  it("does not rewrite an identical backup ID and payload", async () => {
    const { plan, repository } = await fixture();
    const first = await persistRecoveryBackup(repository, "backup-1", plan);
    const second = await persistRecoveryBackup(repository, "backup-1", plan);
    expect(second).toEqual(first);
    expect(repository.writes).toBe(1);
  });

  it("rejects conflicting backup IDs without overwriting prior evidence", async () => {
    const { plan, repository } = await fixture();
    await persistRecoveryBackup(repository, "backup-1", plan);
    const before = repository.data.get("backup-1");
    const modified: ArchivedHeadRecoveryPlan = {
      ...plan, sourceHeadId: "different-head",
    };
    await expect(persistRecoveryBackup(
      repository, "backup-1", modified,
    )).rejects.toThrow("BACKUP_PLAN_MISMATCH");
    expect(repository.data.get("backup-1")).toBe(before);
    expect(repository.writes).toBe(1);
  });

  it("treats write-then-throw as UNKNOWN and reconciles without retry", async () => {
    const { local, plan, repository } = await fixture();
    repository.throwAfterWrite = true;
    await expect(persistRecoveryBackup(
      repository, "backup-1", plan,
    )).rejects.toThrow("BACKUP_WRITE_UNKNOWN_RECONCILE_REQUIRED");
    expect(repository.writes).toBe(1);
    expect(await reconcileRecoveryBackup(repository, "backup-1", plan))
      .toBe("VERIFIED");
    await applyArchivedHeadRecoveryWithBackup(
      local, plan, restoreInput, repository, "backup-1",
    );
    expect(local.load().headId).toBe("local-v2");
    expect(repository.writes).toBe(1);
  });

  it("fails closed on missing, corrupted or mismatched backup payload", async () => {
    const { local, plan, repository } = await fixture();
    expect(await reconcileRecoveryBackup(repository, "backup-1", plan))
      .toBe("MISSING");
    repository.data.set("backup-1", "{bad json");
    expect(await reconcileRecoveryBackup(repository, "backup-1", plan))
      .toBe("CONFLICT");
    await expect(applyArchivedHeadRecoveryWithBackup(
      local, plan, restoreInput, repository, "backup-1",
    )).rejects.toThrow("BACKUP_NOT_VERIFIED");
    expect(local.load().versions).toHaveLength(1);
  });

  it("does not interpret an unreadable backup as an absent backup", async () => {
    const { local, plan, repository } = await fixture();
    repository.readFails = true;
    await expect(persistRecoveryBackup(
      repository, "backup-1", plan,
    )).rejects.toThrow("BACKUP_READ_UNKNOWN");
    await expect(applyArchivedHeadRecoveryWithBackup(
      local, plan, restoreInput, repository, "backup-1",
    )).rejects.toThrow("BACKUP_READ_UNKNOWN");
    expect(repository.writes).toBe(0);
    expect(local.load().versions).toHaveLength(1);
  });

  it("rejects stale local head even with a verified retained backup", async () => {
    const { local, plan, repository } = await fixture();
    await persistRecoveryBackup(repository, "backup-1", plan);
    local.checkpoint({
      ...initial,
      id: "local-v1b",
      actionId: "local-action-2",
      expectedHeadId: "local-v1",
    });
    await expect(applyArchivedHeadRecoveryWithBackup(
      local, plan, restoreInput, repository, "backup-1",
    )).rejects.toThrow("RECOVERY_HEAD_CONFLICT");
    expect(local.load().headId).toBe("local-v1b");
    expect(await reconcileRecoveryBackup(repository, "backup-1", plan))
      .toBe("VERIFIED");
  });

  it("rejects a tampered archive and invalid backup ID before writing", async () => {
    const { plan, repository } = await fixture();
    const damaged: ArchivedHeadRecoveryPlan = {
      ...plan, backupArchive: plan.backupArchive.replace("Local", "Altered"),
    };
    await expect(persistRecoveryBackup(
      repository, "backup-1", damaged,
    )).rejects.toThrow("ARCHIVE_INTEGRITY_FAILURE");
    await expect(persistRecoveryBackup(
      repository, " ", plan,
    )).rejects.toThrow("INVALID_BACKUP_ID");
    expect(repository.writes).toBe(0);
  });
});
