import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { externalInterfaceFromCell, externalInterfaceFromCluster } from "../dist/interface.js";

test("cell and cluster expose the same six-face external interface shape", async () => {
  const raw = await readFile(new URL("../../../examples/recursive-seven-cell-cluster.json", import.meta.url), "utf8");
  const graph = JSON.parse(raw);
  const cell = graph.nodes.find((node) => node.id === "cluster-1");
  const cluster = graph.clusters.find((item) => item.id === "cluster-1");

  const cellInterface = externalInterfaceFromCell(cell);
  const clusterInterface = externalInterfaceFromCluster(cluster);

  assert.equal(cellInterface.faces.length, 6);
  assert.equal(clusterInterface.faces.length, 6);
  assert.deepEqual(cellInterface.faces.map((face) => face.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(clusterInterface.faces.map((face) => face.index), [0, 1, 2, 3, 4, 5]);
});
