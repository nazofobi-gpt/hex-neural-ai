import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SDK_PROTOCOL_VERSION, MAX_GRAPH_JSON_CHARS, validateGraphJson, validateGraphDocument } from "../dist/index.js";

const fixtureUrl = new URL("../../../examples/two-cell-flow.json", import.meta.url);

test("DEV-001 accepts canonical two-cell graph without execution", async () => {
  const input = await readFile(fixtureUrl, "utf8");
  const result = validateGraphJson(input);
  assert.equal(SDK_PROTOCOL_VERSION, "0.1");
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("DEV-001 unsupported protocol fails closed", async () => {
  const graph = JSON.parse(await readFile(fixtureUrl, "utf8"));
  graph.protocolVersion = "999";
  assert.equal(validateGraphDocument(graph).issues[0].code, "UNSUPPORTED_PROTOCOL");
});

test("DEV-001 invalid bounded budget fails closed", async () => {
  const graph = JSON.parse(await readFile(fixtureUrl, "utf8"));
  graph.resourceBudget.maxHops = 0;
  assert.equal(validateGraphDocument(graph).issues[0].code, "INVALID_BUDGET");
});

test("DEV-001 nonadjacent connection propagates core validation errors", async () => {
  const graph = JSON.parse(await readFile(fixtureUrl, "utf8"));
  graph.nodes[1].coordinate.q = 42;
  const result = validateGraphDocument(graph);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.message.startsWith("NON_ADJACENT_DIRECT_CONNECTION:")));
});

test("DEV-001 malformed nested input never crashes", () => {
  const bad = {
    protocolVersion: "0.1", id: "broken", version: "1",
    nodes: [{}], connections: [], resourceBudget: {
      maxHops: 1, maxRuntimeMs: 1, maxExternalCalls: 0, maxCostUnits: null
    }
  };
  const result = validateGraphDocument(bad);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].code, "MALFORMED_GRAPH");
});

test("DEV-001 malformed JSON and oversized payload fail closed", () => {
  assert.equal(validateGraphJson("{broken").issues[0].code, "INVALID_JSON");
  assert.equal(validateGraphJson("x".repeat(MAX_GRAPH_JSON_CHARS + 1)).issues[0].code, "INPUT_TOO_LARGE");
});
