import { expect, test } from "@playwright/test";

/** Real Chromium IndexedDB transactions, not an in-memory CAS mock. */
test("G-263: two tabs contend for one graph head: exactly one wins", async ({ context }) => {
  const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
  await Promise.all([first.goto("/"), second.goto("/")]);
  const databaseName = `g263-cas-${crypto.randomUUID()}`;
  const contender = (page: typeof first, suffix: string) => page.evaluate(
    async ({ databaseName, suffix }) => {
      const { checkpointIndexedDb } = await import("/src/versionIndexedDb.ts");
      try {
        await checkpointIndexedDb(databaseName, "same-project", {
          id: `version-${suffix}`,
          actionId: `action-${suffix}`,
          expectedHeadId: null,
          label: `Tab ${suffix}`,
          createdAt: "2026-10-24T10:00:00Z",
          snapshot: { nodes: [{ id: `node-${suffix}`, label: suffix, q: 0, r: 0 }], nextSequence: 2 },
        });
        return "APPLIED";
      } catch (error) {
        return (error as Error).message;
      }
    }, { databaseName, suffix },
  );
  const outcomes = await Promise.all([
    contender(first, "A"), contender(second, "B"),
  ]);
  expect(outcomes.sort()).toEqual(["APPLIED", "HEAD_CONFLICT"]);
  const history = await first.evaluate(async (name) => {
    const { readIndexedDbHistory } = await import("/src/versionIndexedDb.ts");
    return readIndexedDbHistory(name, "same-project");
  }, databaseName);
  expect(history.versions).toHaveLength(1);
  expect(history.headId).toBe(history.versions[0].id);
  await Promise.all([first.close(), second.close()]);
});

test("G-263: same action is idempotent, conflicting payload is rejected", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { checkpointIndexedDb, reconcileIndexedDbCheckpoint, readIndexedDbHistory } =
      await import("/src/versionIndexedDb.ts");
    const db = `g263-dedup-${crypto.randomUUID()}`;
    const input = {
      id: "version-1", actionId: "stable-action-1", expectedHeadId: null,
      label: "Original", createdAt: "2026-10-24T10:01:00Z",
      snapshot: { nodes: [{ id: "node-1", label: "A", q: 0, r: 0 }], nextSequence: 2 },
    };
    const first = await checkpointIndexedDb(db, "project-A", input);
    const duplicate = await checkpointIndexedDb(db, "project-A", input);
    let conflict = "";
    try {
      await checkpointIndexedDb(db, "project-A", { ...input, label: "Changed" });
    } catch (error) { conflict = (error as Error).message; }
    const history = await readIndexedDbHistory(db, "project-A");
    const same = await reconcileIndexedDbCheckpoint(db, "project-A", input);
    const different = await reconcileIndexedDbCheckpoint(db, "project-A", { ...input, label: "Changed" });
    const other = await readIndexedDbHistory(db, "project-B");
    return { first, duplicate, conflict, count: history.versions.length, same, different, otherCount: other.versions.length };
  });
  expect(result.first).toEqual(result.duplicate);
  expect(result.conflict).toBe("ACTION_CONFLICT");
  expect(result.count).toBe(1);
  expect(result.same).toBe("APPLIED");
  expect(result.different).toBe("CONFLICT");
  expect(result.otherCount).toBe(0);
});

test("G-263: corrupt IDB history fails closed without overwriting", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { checkpointIndexedDb } = await import("/src/versionIndexedDb.ts");
    const name = `g263-corrupt-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("graphHistories");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("graphHistories", "readwrite");
        tx.objectStore("graphHistories").put("{invalid-json", "project-A");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    let error = "";
    try {
      await checkpointIndexedDb(name, "project-A", {
        id: "v1", actionId: "a1", expectedHeadId: null,
        label: "Unsafe", createdAt: "2026-10-24T10:02:00Z",
        snapshot: { nodes: [], nextSequence: 1 },
      });
    } catch (caught) { error = (caught as Error).message; }
    const persisted = await new Promise<string>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("graphHistories", "readonly");
        const get = tx.objectStore("graphHistories").get("project-A");
        get.onsuccess = () => { resolve(get.result as string); db.close(); };
        get.onerror = () => reject(get.error);
      };
    });
    return { error, persisted };
  });
  expect(result).toEqual({ error: "CORRUPT_HISTORY", persisted: "{invalid-json" });
});
