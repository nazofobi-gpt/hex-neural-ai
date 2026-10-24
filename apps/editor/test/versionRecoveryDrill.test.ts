import { describe, expect, it } from "vitest";
import { exportVersionArchive } from "../src/versionArchive";
import { runIsolatedRecoveryDrill } from "../src/versionRecoveryDrill";
import { VersionStore, type VersionStorage } from "../src/versionStore";

class MemoryStorage implements VersionStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const localCheckpoint = {
  id: "local-v1",
  actionId: "local-action-1",
  expectedHeadId: null,
  label: "Local graph",
  createdAt: "2026-10-24T08:00:00Z",
  snapshot: {
    nodes: [{ id: "local-node", label: "Local", q: 0, r: 0 }],
    nextSequence: 2,
  },
};
const sourceCheckpoint = {
  id: "source-v1",
  actionId: "source-action-1",
  expectedHeadId: null,
  label: "Archived graph",
  createdAt: "2026-10-24T08:01:00Z",
  snapshot: {
    nodes: [{ id: "source-node", label: "Archived", q: 2, r: -1 }],
    nextSequence: 2,
  },
};
const restoreInput = {
  id: "local-v2",
  actionId: "drill-action-1",
  expectedHeadId: "local-v1",
  label: "Simulated archived HEAD",
  createdAt: "2026-10-24T08:02:00Z",
};

async function fixture() {
  const local = new VersionStore(new MemoryStorage(), "project-A");
  const source = new VersionStore(new MemoryStorage(), "project-A");
  local.checkpoint(localCheckpoint);
  source.checkpoint(sourceCheckpoint);
  return {
    local,
    source,
    localArchive: await exportVersionArchive(local),
    sourceArchive: await exportVersionArchive(source),
  };
}

describe("G-263 isolated recovery drill", () => {
  it("simulates verified backup and restore without touching the real store", async () => {
    const { local, localArchive, sourceArchive } = await fixture();
    const before = local.exportJson();
    const report = await runIsolatedRecoveryDrill(
      "project-A", localArchive, sourceArchive, restoreInput, "drill-backup-1",
    );
    expect(report).toEqual({
      format: "hex.isolatedRecoveryDrill.v1",
      mode: "ISOLATED_SIMULATION_ONLY",
      projectId: "project-A",
      sourceHeadId: "source-v1",
      previousHeadId: "local-v1",
      simulatedHeadId: "local-v2",
      previousVersionCount: 1,
      simulatedVersionCount: 2,
      backupReadback: "EPHEMERAL_VERIFIED_ONLY",
      actionReconciliation: "APPLIED",
    });
    expect(local.exportJson()).toBe(before);
    expect(await exportVersionArchive(local)).toBe(localArchive);
  });

  it("fails closed when the proposed restore expected HEAD is stale", async () => {
    const { local, localArchive, sourceArchive } = await fixture();
    await expect(runIsolatedRecoveryDrill(
      "project-A", localArchive, sourceArchive,
      { ...restoreInput, expectedHeadId: "stale" }, "drill-backup-2",
    )).rejects.toThrow("RECOVERY_HEAD_CONFLICT");
    expect(local.load().headId).toBe("local-v1");
  });

  it("rejects reused action IDs rather than reporting a successful restore", async () => {
    const { localArchive, sourceArchive } = await fixture();
    await expect(runIsolatedRecoveryDrill(
      "project-A", localArchive, sourceArchive,
      { ...restoreInput, actionId: "local-action-1" }, "drill-backup-3",
    )).rejects.toThrow("RECOVERY_RECONCILE_REQUIRED");
  });

  it("rejects a foreign project archive before simulating any write", async () => {
    const { localArchive } = await fixture();
    const foreign = new VersionStore(new MemoryStorage(), "project-B");
    foreign.checkpoint(sourceCheckpoint);
    await expect(runIsolatedRecoveryDrill(
      "project-A", localArchive, await exportVersionArchive(foreign),
      restoreInput, "drill-backup-4",
    )).rejects.toThrow("ARCHIVE_PROJECT_MISMATCH");
  });

  it("rejects checksum-tampered source archives", async () => {
    const { localArchive, sourceArchive } = await fixture();
    const tampered = JSON.parse(sourceArchive);
    tampered.document.versions[0].snapshot.nodes[0].label = "Tampered";
    await expect(runIsolatedRecoveryDrill(
      "project-A", localArchive, JSON.stringify(tampered),
      restoreInput, "drill-backup-5",
    )).rejects.toThrow("ARCHIVE_INTEGRITY_FAILURE");
  });

  it("rejects an empty source archive", async () => {
    const { localArchive } = await fixture();
    const empty = new VersionStore(new MemoryStorage(), "project-A");
    await expect(runIsolatedRecoveryDrill(
      "project-A", localArchive, await exportVersionArchive(empty),
      restoreInput, "drill-backup-6",
    )).rejects.toThrow("DRILL_SOURCE_EMPTY");
  });

  it("rejects invalid backup identifiers before simulating restore", async () => {
    const { localArchive, sourceArchive } = await fixture();
    await expect(runIsolatedRecoveryDrill(
      "project-A", localArchive, sourceArchive, restoreInput, " ",
    )).rejects.toThrow("INVALID_BACKUP_ID");
  });
});
