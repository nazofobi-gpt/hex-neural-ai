import { expect, test } from "@playwright/test";

const firstSnapshot = {
  nodes: [{ id: "node-1", label: "First", q: 0, r: 0 }],
  nextSequence: 2,
};
const secondSnapshot = {
  nodes: [{ id: "node-2", label: "Second", q: 1, r: 0 }],
  nextSequence: 3,
};

test("G-263: Chromium exports committed IndexedDB history without mutation", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async ({ firstSnapshot, secondSnapshot }) => {
    const { checkpointIndexedDb, readIndexedDbHistory } =
      await import("/src/versionIndexedDb.ts");
    const { exportIndexedDbVersionArchive } =
      await import("/src/versionIndexedDbArchive.ts");
    const { inspectVersionArchive } = await import("/src/versionArchive.ts");
    const db = `g263-idb-export-${crypto.randomUUID()}`;
    await checkpointIndexedDb(db, "project-A", {
      id: "v1", actionId: "seed-1", expectedHeadId: null,
      label: "First", createdAt: "2026-10-24T10:00:00Z", snapshot: firstSnapshot,
    });
    await checkpointIndexedDb(db, "project-A", {
      id: "v2", actionId: "seed-2", expectedHeadId: "v1",
      label: "Second", createdAt: "2026-10-24T10:01:00Z", snapshot: secondSnapshot,
    });
    const before = await readIndexedDbHistory(db, "project-A");
    const archive = await exportIndexedDbVersionArchive(db, "project-A");
    const decoded = await inspectVersionArchive(archive, "project-A");
    const after = await readIndexedDbHistory(db, "project-A");
    let foreignProjectError = "";
    try {
      await inspectVersionArchive(archive, "project-B");
    } catch (error) {
      foreignProjectError = (error as Error).message;
    }
    return { before, decoded, after, foreignProjectError };
  }, { firstSnapshot, secondSnapshot });
  expect(result.before).toEqual(result.after);
  expect(result.decoded).toEqual(result.before);
  expect(result.decoded.headId).toBe("v2");
  expect(result.decoded.versions).toHaveLength(2);
  expect(result.foreignProjectError).toBe("ARCHIVE_PROJECT_MISMATCH");
});

test("G-263: corrupt IndexedDB history cannot be exported as a valid archive", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (snapshot) => {
    const { checkpointIndexedDb } = await import("/src/versionIndexedDb.ts");
    const { exportIndexedDbVersionArchive } =
      await import("/src/versionIndexedDbArchive.ts");
    const db = `g263-idb-export-corrupt-${crypto.randomUUID()}`;
    await checkpointIndexedDb(db, "project-A", {
      id: "v1", actionId: "seed-1", expectedHeadId: null,
      label: "First", createdAt: "2026-10-24T10:00:00Z", snapshot,
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(db, 1);
      request.onerror = () => reject(new Error("TEST_IDB_OPEN_FAILED"));
      request.onsuccess = () => {
        const database = request.result;
        const tx = database.transaction("graphHistories", "readwrite");
        tx.objectStore("graphHistories").put("{", "project-A");
        tx.oncomplete = () => { database.close(); resolve(); };
        tx.onerror = () => { database.close(); reject(new Error("TEST_IDB_WRITE_FAILED")); };
      };
    });
    try {
      await exportIndexedDbVersionArchive(db, "project-A");
      return "UNSAFE_EXPORT_SUCCEEDED";
    } catch (error) {
      return (error as Error).message;
    }
  }, firstSnapshot);
  expect(result).toBe("CORRUPT_HISTORY");
});
