import test from "node:test";
import assert from "node:assert/strict";
import { DeveloperClientError, HexDeveloperClient } from "../dist/index.js";

function transport(response) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return typeof response === "function" ? response(request) : response;
    },
  };
}

test("DEV-003 rejects inline credentials before transport", async () => {
  const t = transport({ subject: "u", scopes: ["auth:read"] });
  const client = new HexDeveloperClient(t, {
    credentialRef: "sk-proj-secret",
    scopes: ["auth:read"],
  });
  await assert.rejects(
    () => client.authStatus(),
    (error) => error instanceof DeveloperClientError
      && error.code === "INVALID_CREDENTIAL_REFERENCE",
  );
  assert.equal(t.calls.length, 0);
});

test("DEV-003 missing scope fails closed before transport", async () => {
  const t = transport([]);
  const client = new HexDeveloperClient(t, {
    credentialRef: "vault://workspace/dev",
    scopes: ["auth:read"],
  });
  await assert.rejects(
    () => client.listProjects(),
    (error) => error instanceof DeveloperClientError && error.code === "MISSING_SCOPE",
  );
  assert.equal(t.calls.length, 0);
});

test("DEV-003 project list uses only typed fixed route", async () => {
  const t = transport([{ id: "project-a", name: "Project A" }]);
  const client = new HexDeveloperClient(t, {
    credentialRef: "vault://workspace/dev",
    scopes: ["projects:read"],
  });
  const projects = await client.listProjects();
  assert.deepEqual(projects, [{ id: "project-a", name: "Project A" }]);
  assert.deepEqual(t.calls[0], {
    operation: "projects.list",
    method: "GET",
    path: "/v1/projects",
    credentialRef: "vault://workspace/dev",
  });
});

test("DEV-003 run IDs and project IDs are path-safe", async () => {
  const t = transport({ runId: "run-1", state: "QUEUED" });
  const client = new HexDeveloperClient(t, {
    credentialRef: "vault://workspace/dev",
    scopes: ["runs:execute", "logs:read"],
  });
  await assert.rejects(
    () => client.startRun("../escape", { graphId: "graph-a", graphVersion: "v1" }),
    (error) => error instanceof DeveloperClientError && error.code === "INVALID_IDENTIFIER",
  );
  await assert.rejects(
    () => client.readLogs("run/../../secret"),
    (error) => error instanceof DeveloperClientError && error.code === "INVALID_IDENTIFIER",
  );
  assert.equal(t.calls.length, 0);
});

test("DEV-003 deploy requires explicit confirmation before transport", async () => {
  const t = transport({ deploymentId: "dep-1", state: "STAGED" });
  const client = new HexDeveloperClient(t, {
    credentialRef: "vault://workspace/dev",
    scopes: ["deployments:write"],
  });
  await assert.rejects(
    () => client.deploy("project-a", {
      graphId: "graph-a",
      graphVersion: "v1",
      environment: "staging",
      confirm: false,
    }),
    (error) => error instanceof DeveloperClientError
      && error.code === "EXPLICIT_CONFIRMATION_REQUIRED",
  );
  assert.equal(t.calls.length, 0);
});

test("DEV-003 valid scoped run and bounded logs preserve typed receipts", async () => {
  const t = transport((request) => {
    if (request.operation === "runs.start") return { runId: "run-1", state: "QUEUED" };
    if (request.operation === "logs.read") {
      return { runId: "run-1", events: [{ at: "2026-10-07T12:00:00Z", level: "INFO", message: "queued" }] };
    }
    throw new Error("unexpected");
  });
  const client = new HexDeveloperClient(t, {
    credentialRef: "vault://workspace/dev",
    scopes: ["runs:execute", "logs:read"],
  });
  assert.equal((await client.startRun("project-a", { graphId: "graph-a", graphVersion: "v1" })).runId, "run-1");
  assert.equal((await client.readLogs("run-1")).events[0].message, "queued");
  assert.equal(t.calls.length, 2);
});

test("DEV-003 malformed or unbounded responses fail closed", async () => {
  const tooMany = Array.from({ length: 1001 }, () => ({
    at: "2026-10-07T12:00:00Z", level: "INFO", message: "x",
  }));
  const t = transport({ runId: "run-1", events: tooMany });
  const client = new HexDeveloperClient(t, {
    credentialRef: "vault://workspace/dev",
    scopes: ["logs:read"],
  });
  await assert.rejects(
    () => client.readLogs("run-1"),
    (error) => error instanceof DeveloperClientError
      && error.code === "INVALID_TRANSPORT_RESPONSE",
  );
});
