import test from "node:test";
import assert from "node:assert/strict";
import { HexDeveloperClient, LocalDeveloperMockHost } from "../dist/developerClient.js";

test("DEV-006 mock host is deterministic and offline", async () => {
  const host = new LocalDeveloperMockHost();
  const client = new HexDeveloperClient(host, {
    credentialRef: "vault://local/mock",
    scopes: ["auth:read", "projects:read", "runs:execute"],
  });
  assert.equal((await client.authStatus()).subject, "local-fixture");
  assert.deepEqual(await client.listProjects(), [{ id: "mock-project", name: "Local Fixture" }]);
  await assert.rejects(() => client.startRun("mock-project", {
    graphId: "g", graphVersion: "v1",
  }), /LOCAL_MOCK_UNSUPPORTED_OPERATION/);
});
