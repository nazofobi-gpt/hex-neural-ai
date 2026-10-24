import { expect, test } from "@playwright/test";

const firstSnapshot = {
  nodes: [{ id: "node-1", label: "First", q: 0, r: 0 }],
  nextSequence: 2,
};
const secondSnapshot = {
  nodes: [{ id: "node-2", label: "Second", q: 1, r: 0 }],
  nextSequence: 3,
};

/** Actual Chromium IndexedDB transactions, not a simulated CAS provider. */
test("G-263: concurrent browser restores have one winner and preserve history", async ({ context }) => {
  const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
  await Promise.all([first.goto("/"), second.goto("/")]);
  const db = `g263-restore-race-${crypto.randomUUID()}`;
  await first.evaluate(async ({ db, firstSnapshot, secondSnapshot }) => {
    const { checkpointIndexedDb } = await import("/src/versionIndexedDb.ts");
    await checkpointIndexedDb(db, "project-A", {
      id: "v1", actionId: "create-1", expectedHeadId: null,
      label: "First", createdAt: "2026-10-24T10:00:00Z", snapshot: firstSnapshot,
    });
    await checkpointIndexedDb(db, "project-A", {
      id: "v2", actionId: "create-2", expectedHeadId: "v1",
      label: "Second", createdAt: "2026-10-24T10:01:00Z", snapshot: secondSnapshot,
    });
  }, { db, firstSnapshot, secondSnapshot });
  const contend = (page: typeof first, suffix: string) => page.evaluate(
    async ({ db, suffix }) => {
      const { restoreIndexedDbVersion } = await import("/src/versionIndexedDbRestore.ts");
      try {
        await restoreIndexedDbVersion(db, "project-A", {
          id: `restore-${suffix}`, actionId: `restore-action-${suffix}`,
          expectedHeadId: "v2", targetId: "v1", label: `Restore ${suffix}`,
          createdAt: "2026-10-24T10:02:00Z",
        });
        return "APPLIED";
      } catch (error) {
        return (error as Error).message;
      }
    }, { db, suffix },
  );
  const results = await Promise.all([contend(first, "A"), contend(second, "B")]);
  expect(results.sort()).toEqual(["APPLIED", "HEAD_CONFLICT"]);
  const history = await first.evaluate(async (name) => {
    const { readIndexedDbHistory } = await import("/src/versionIndexedDb.ts");
    return readIndexedDbHistory(name, "project-A");
  }, db);
  expect(history.versions).toHaveLength(3);
  expect(history.versions[2].parentId).toBe("v2");
  expect(history.versions[2].restoredFromId).toBe("v1");
  expect(history.versions[2].snapshot).toEqual(firstSnapshot);
  expect(history.versions[1].snapshot).toEqual(secondSnapshot);
  await Promise.all([first.close(), second.close()]);
});

test("G-263: duplicate restore reconciles; conflicting action and missing target fail closed", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async ({ firstSnapshot, secondSnapshot }) => {
    const { checkpointIndexedDb, readIndexedDbHistory } = await import("/src/versionIndexedDb.ts");
    const { restoreIndexedDbVersion, reconcileIndexedDbRestore } =
      await import("/src/versionIndexedDbRestore.ts");
    const db = `g263-restore-dedup-${crypto.randomUUID()}`;
    await checkpointIndexedDb(db, "project-A", {
      id: "v1", actionId: "seed-1", expectedHeadId: null,
      label: "First", createdAt: "2026-10-24T10:00:00Z", snapshot: firstSnapshot,
    });
    await checkpointIndexedDb(db, "project-A", {
      id: "v2", actionId: "seed-2", expectedHeadId: "v1",
      label: "Second", createdAt: "2026-10-24T10:01:00Z", snapshot: secondSnapshot,
    });
    const input = {
      id: "restored", actionId: "stable-restore", expectedHeadId: "v2",
      targetId: "v1", label: "Restore", createdAt: "2026-10-24T10:02:00Z",
    };
    const first = await restoreIndexedDbVersion(db, "project-A", input);
    const duplicate = await restoreIndexedDbVersion(db, "project-A", input);
    const applied = await reconcileIndexedDbRestore(db, "project-A", input);
    const conflict = await reconcileIndexedDbRestore(db, "project-A", {
      ...input, targetId: "v2",
    });
    let actionError = "";
    try {
      await restoreIndexedDbVersion(db, "project-A", { ...input, targetId: "v2" });
    } catch (error) { actionError = (error as Error).message; }
    let missingError = "";
    try {
      await restoreIndexedDbVersion(db, "project-A", {
        ...input, id: "never", actionId: "new-action",
        expectedHeadId: "restored", targetId: "not-present",
      });
    } catch (error) { missingError = (error as Error).message; }
    const history = await readIndexedDbHistory(db, "project-A");
    const otherProject = await readIndexedDbHistory(db, "project-B");
    return {
      first, duplicate, applied, conflict, actionError, missingError,
      count: history.versions.length, otherCount: otherProject.versions.length,
    };
  }, { firstSnapshot, secondSnapshot });
  expect(result.first).toEqual(result.duplicate);
  expect(result.first.restoredFromId).toBe("v1");
  expect(result.applied).toBe("APPLIED");
  expect(result.conflict).toBe("CONFLICT");
  expect(result.actionError).toBe("ACTION_CONFLICT");
  expect(result.missingError).toBe("MISSING_RESTORE_TARGET");
  expect(result.count).toBe(3);
  expect(result.otherCount).toBe(0);
});
