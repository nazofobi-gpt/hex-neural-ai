import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  HexApiClient,
  LocalMockTransport,
  SdkClientError,
} from "../dist/index.js";

const fixtureUrl = new URL("../../../examples/two-cell-flow.json", import.meta.url);

test("DEV-002 typed client validates through deterministic local mock only", async () => {
  const graph = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const client = new HexApiClient(new LocalMockTransport());
  const result = await client.validateGraph(graph);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.graphId, graph.id);
});

test("DEV-002 local mock preserves fail-closed protocol validation", async () => {
  const graph = JSON.parse(await readFile(fixtureUrl, "utf8"));
  graph.protocolVersion = "999";
  const client = new HexApiClient(new LocalMockTransport());
  const result = await client.validateGraph(graph);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].code, "UNSUPPORTED_PROTOCOL");
});

test("DEV-002 client rejects malformed transport envelopes", async () => {
  const client = new HexApiClient({
    async request() {
      return { valid: "yes" };
    },
  });

  await assert.rejects(
    () => client.validateGraph({}),
    (error) => error instanceof SdkClientError
      && error.code === "INVALID_TRANSPORT_RESPONSE",
  );
});
