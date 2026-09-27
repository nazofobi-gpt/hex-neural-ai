import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateGraph } from "../dist/validate.js";

async function fixture() {
  const raw = await readFile(new URL("../../../examples/two-cell-flow.json", import.meta.url), "utf8");
  return JSON.parse(raw);
}

test("reference two-cell graph passes core validation", async () => {
  const graph = await fixture();
  const result = validateGraph(graph);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("non-adjacent direct connection is rejected", async () => {
  const graph = await fixture();
  graph.nodes[1].coordinate.q = 2;
  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "NON_ADJACENT_DIRECT_CONNECTION"));
});

test("schema mismatch requires an explicit transform", async () => {
  const graph = await fixture();
  graph.nodes[1].faces[3].semanticChannels[0].schema = "application/json";
  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "INCOMPATIBLE_CHANNEL_SCHEMA"));
});
