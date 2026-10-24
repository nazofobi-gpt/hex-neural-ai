import { describe, expect, it } from "vitest";
import { exportVersionArchive } from "../src/versionArchive";
import {
  applyArchivedHeadRecovery,
  prepareArchivedHeadRecovery,
  reconcileArchivedHeadRecovery,
} from "../src/versionArchiveRecovery";
import {
  VersionStore,
  type VersionStorage,
} from "../src/versionStore";

class MemoryStorage implements VersionStorage {
  readonly data = new Map<string, string>();
  writes = 0;
  throwAfterWrite = false;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.data.set(key, value);
    if (this.throwAfterWrite) throw new Error("ambiguous storage response");
  }
}

const initial = {
  id: "local-v1",
  actionId: "local-action-1",
  expectedHeadId: null,
  label: "Local initial",
  createdAt: "2026-10-24T06:00:00Z",
  snapshot: {
    nodes: [{ id: "local-node", label: "Local", q: 0, r: 0 }],
    nextSequence: 2,
  },
};

const archived = {
  id: "remote-v1",
  actionId: "remote-action-1",
  expectedHeadId: null,
  label: "Archive initial",
  createdAt: "2026-10-24T06:01:00Z",
  snapshot: {
    nodes: [{ id: "archived-node", label: "Recovered", q: 3, r: -1 }],
    nextSequence: 2,
  },
};

const restoreInput = {
  id: "local-v2",
  actionId: "restore-action-1",
  expectedHeadId: "local-v1",
  label: "Restore archived head",
  createdAt: "2026-10-24T06:02:00Z",
};

async function fixture() {
  const localStorage = new MemoryStorage();
  const local = new VersionStore(localStorage, "project-A");
  local.checkpoint(initial);
  const sourceStorage = new MemoryStorage();
  const source = new VersionStore(sourceStorage, "project-A");
  source.checkpoint(archived);
  const archive = await exportVersionArchive(source);
  return { local, localStorage, source, sourceStorage, archive };
}

describe("G-263 guarded archived-head recovery", () => {
  it("prepares without any mutation and includes an exact local backup", async () => {
    const { local, localStorage, archive } = await fixture();
    const writes = localStorage.writes;
    const before = local.load();
    const plan = await prepareArchivedHeadRecovery(local, archive);
    expect(plan.projectId).toBe("project-A");
    expect(plan.expectedHeadId).toBe("local-v1");
    expect(plan.sourceHeadId).toBe("remote-v1");
    expect(plan.backupArchive).toBe(await exportVersionArchive(local));
    expect(local.load()).toEqual(before);
    expect(localStorage.writes).toBe(writes);
  });

  it("appends archived HEAD as a new checkpoint without erasing local history", async () => {
    const { local, source, archive } = await fixture();
    const plan = await prepareArchivedHeadRecovery(local, archive);
    const record = await applyArchivedHeadRecovery(local, plan, restoreInput);
    expect(record.id).toBe("local-v2");
    expect(record.parentId).toBe("local-v1");
    expect(record.restoredFromId).toBeUndefined();
    expect(record.snapshot).toEqual(source.load().versions[0].snapshot);
    expect(local.load().versions.map((v) => v.id)).toEqual([
      "local-v1", "local-v2",
    ]);
    expect(local.load().versions[0].snapshot.nodes[0].label).toBe("Local");
    expect(await reconcileArchivedHeadRecovery(local, plan, restoreInput))
      .toBe("APPLIED");
  });

  it("rejects an empty archive and a foreign project before writing", async () => {
    const { local, localStorage } = await fixture();
    const empty = new VersionStore(new MemoryStorage(), "project-A");
    const foreign = new VersionStore(new MemoryStorage(), "project-B");
    foreign.checkpoint(archived);
    const writes = localStorage.writes;
    await expect(prepareArchivedHeadRecovery(
      local, await exportVersionArchive(empty),
    )).rejects.toThrow("ARCHIVE_EMPTY");
    await expect(prepareArchivedHeadRecovery(
      local, await exportVersionArchive(foreign),
    )).rejects.toThrow("ARCHIVE_PROJECT_MISMATCH");
    expect(localStorage.writes).toBe(writes);
  });

  it("rejects tampered source archives before any mutation", async () => {
    const { local, localStorage, archive } = await fixture();
    const tampered = JSON.parse(archive);
    tampered.document.versions[0].snapshot.nodes[0].label = "Modified";
    const writes = localStorage.writes;
    await expect(prepareArchivedHeadRecovery(
      local, JSON.stringify(tampered),
    )).rejects.toThrow("ARCHIVE_INTEGRITY_FAILURE");
    expect(localStorage.writes).toBe(writes);
  });

  it("rejects a stale local HEAD after an independent checkpoint", async () => {
    const { local, localStorage, archive } = await fixture();
    const plan = await prepareArchivedHeadRecovery(local, archive);
    local.checkpoint({
      ...initial,
      id: "local-v1b",
      actionId: "local-action-2",
      expectedHeadId: "local-v1",
    });
    const writes = localStorage.writes;
    await expect(applyArchivedHeadRecovery(
      local, plan, restoreInput,
    )).rejects.toThrow("RECOVERY_HEAD_CONFLICT");
    expect(localStorage.writes).toBe(writes);
    expect(await reconcileArchivedHeadRecovery(local, plan, restoreInput))
      .toBe("NOT_APPLIED");
  });

  it("rejects a reused action ID and requires explicit reconciliation", async () => {
    const { local, localStorage, archive } = await fixture();
    const plan = await prepareArchivedHeadRecovery(local, archive);
    const writes = localStorage.writes;
    await expect(applyArchivedHeadRecovery(local, plan, {
      ...restoreInput,
      actionId: "local-action-1",
    })).rejects.toThrow("RECOVERY_RECONCILE_REQUIRED");
    expect(localStorage.writes).toBe(writes);
    expect(await reconcileArchivedHeadRecovery(local, plan, {
      ...restoreInput,
      actionId: "local-action-1",
    })).toBe("CONFLICT");
  });

  it("reconciles a write-then-throw UNKNOWN without replaying it", async () => {
    const { local, localStorage, archive } = await fixture();
    const plan = await prepareArchivedHeadRecovery(local, archive);
    localStorage.throwAfterWrite = true;
    await expect(applyArchivedHeadRecovery(
      local, plan, restoreInput,
    )).rejects.toThrow("WRITE_UNKNOWN_RECONCILE_REQUIRED");
    expect(await reconcileArchivedHeadRecovery(local, plan, restoreInput))
      .toBe("APPLIED");
    expect(local.load().versions).toHaveLength(2);
    await expect(applyArchivedHeadRecovery(
      local, plan, restoreInput,
    )).rejects.toThrow("RECOVERY_RECONCILE_REQUIRED");
  });

  it("keeps the backup intact and does not pretend to undo external effects", async () => {
    const { local, archive } = await fixture();
    const plan = await prepareArchivedHeadRecovery(local, archive);
    const backup = plan.backupArchive;
    await applyArchivedHeadRecovery(local, plan, restoreInput);
    expect(backup).toBe(plan.backupArchive);
    expect((await import("../src/versionArchive")).inspectVersionArchive(
      backup, "project-A",
    )).resolves.toMatchObject({ headId: "local-v1" });
    expect(local.load().headId).toBe("local-v2");
  });
});
