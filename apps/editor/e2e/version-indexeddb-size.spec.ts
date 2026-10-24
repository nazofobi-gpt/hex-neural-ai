import { expect, test } from "@playwright/test";

/** Real Chromium IDB limits: reject oversized history before parsing or committing. */
test("G-263: oversized persisted IDB history fails closed without overwrite", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { MAX_INDEXEDDB_HISTORY_BYTES, checkpointIndexedDb, readIndexedDbHistory } =
      await import("/src/versionIndexedDb.ts");
    const name = "g263-size-corrupt-" + crypto.randomUUID();
    const oversized = "x".repeat(MAX_INDEXEDDB_HISTORY_BYTES + 1);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("graphHistories");
      request.onerror = () => reject(new Error("TEST_IDB_OPEN_FAILED"));
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("graphHistories", "readwrite");
        tx.objectStore("graphHistories").put(oversized, "project-A");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(new Error("TEST_IDB_WRITE_FAILED")); };
      };
    });
    let readError = "";
    try { await readIndexedDbHistory(name, "project-A"); }
    catch (error) { readError = (error as Error).message; }
    let writeError = "";
    try {
      await checkpointIndexedDb(name, "project-A", {
        id: "v1", actionId: "oversize-1", expectedHeadId: null,
        label: "Blocked", createdAt: "2026-10-24T12:00:00Z",
        snapshot: { nodes: [], nextSequence: 1 },
      });
    } catch (error) { writeError = (error as Error).message; }
    const unchanged = await new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onerror = () => reject(new Error("TEST_IDB_REOPEN_FAILED"));
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("graphHistories", "readonly");
        const get = tx.objectStore("graphHistories").get("project-A");
        tx.oncomplete = () => { db.close(); resolve(get.result === oversized); };
        tx.onabort = () => { db.close(); reject(new Error("TEST_IDB_READ_FAILED")); };
      };
    });
    return { readError, writeError, unchanged };
  });
  expect(result).toEqual({
    readError: "INDEXEDDB_HISTORY_TOO_LARGE",
    writeError: "INDEXEDDB_HISTORY_TOO_LARGE",
    unchanged: true,
  });
});

test("G-263: oversized candidate checkpoint aborts atomically, preserving HEAD", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { checkpointIndexedDb, readIndexedDbHistory } =
      await import("/src/versionIndexedDb.ts");
    const name = "g263-size-write-" + crypto.randomUUID();
    const snapshot = {
      nodes: Array.from({ length: 5000 }, (_, i) => ({
        id: "node-" + i, label: "L".repeat(512), q: i, r: 0,
      })),
      nextSequence: 5001,
    };
    await checkpointIndexedDb(name, "project-A", {
      id: "v1", actionId: "size-first", expectedHeadId: null,
      label: "First", createdAt: "2026-10-24T12:01:00Z", snapshot,
    });
    const before = await readIndexedDbHistory(name, "project-A");
    let error = "";
    try {
      await checkpointIndexedDb(name, "project-A", {
        id: "v2", actionId: "size-second", expectedHeadId: "v1",
        label: "Second", createdAt: "2026-10-24T12:02:00Z", snapshot,
      });
    } catch (caught) { error = (caught as Error).message; }
    const after = await readIndexedDbHistory(name, "project-A");
    return {
      error, unchanged: JSON.stringify(before) === JSON.stringify(after),
      head: after.headId, count: after.versions.length,
    };
  });
  expect(result).toEqual({
    error: "INDEXEDDB_HISTORY_TOO_LARGE",
    unchanged: true, head: "v1", count: 1,
  });
});
