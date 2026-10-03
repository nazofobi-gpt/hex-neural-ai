import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deriveMacroFaces } from "../dist/cluster.js";

test("radius-1 seven-cell cluster exposes three boundary faces per direction", async () => {
  const raw = await readFile(new URL("../../../examples/recursive-seven-cell-cluster.json", import.meta.url), "utf8");
  const graph = JSON.parse(raw);
  const children = graph.nodes.filter((node) => node.parentId === "cluster-1");

  const macroFaces = deriveMacroFaces(children);

  assert.equal(macroFaces.length, 6);
  assert.deepEqual(
    macroFaces.map((face) => face.exposedChildFaces.length),
    [3, 3, 3, 3, 3, 3],
  );
});
