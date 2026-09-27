import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AXIAL_DIRECTIONS,
  compileCluster,
  deriveMacroFaces,
  externalInterfaceFromCell,
  externalInterfaceFromCluster,
} from "../dist/index.js";

const NOW = "2026-09-27T09:40:00+02:00";

function blankFace(index, nodeId) {
  return {
    index,
    semanticChannels: [
      {
        id: `${nodeId}.face.${index}`,
        direction: "bidirectional",
        transport: "message",
        schema: "application/json",
        optional: true,
      },
    ],
    projectionPopulation: [`${nodeId}.projection.${index}`],
    inputPolicy: "allow",
    outputPolicy: "allow",
    acceptedSchemas: ["application/json"],
    connectionIds: [],
  };
}

function makeCell(id, q, r, parentId, level = 1, kind = "compute") {
  return {
    id,
    kind,
    level,
    parentId,
    coordinate: { q, r },
    faces: [0, 1, 2, 3, 4, 5].map((index) => blankFace(index, id)),
    neuralCircuitRef: null,
    config: { label: id },
    stateRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function radiusOne(parentId, level, prefix) {
  return [
    makeCell(`${prefix}-center`, 0, 0, parentId, level),
    ...AXIAL_DIRECTIONS.map((direction, index) =>
      makeCell(
        `${prefix}-${index}`,
        direction.q,
        direction.r,
        parentId,
        level,
      ),
    ),
  ];
}

test("radius-1 seven-cell cluster exposes three boundary faces per direction", async () => {
  const raw = await readFile(
    new URL(
      "../../../examples/recursive-seven-cell-cluster.json",
      import.meta.url,
    ),
    "utf8",
  );
  const graph = JSON.parse(raw);
  const children = graph.nodes.filter(
    (node) => node.parentId === "cluster-1",
  );

  const macroFaces = deriveMacroFaces(children);

  assert.equal(macroFaces.length, 6);
  assert.deepEqual(
    macroFaces.map((face) => face.exposedChildFaces.length),
    [3, 3, 3, 3, 3, 3],
  );
});

test("macro-face derivation is deterministic regardless of child input order", () => {
  const children = radiusOne("cluster", 1, "cell");
  const forward = deriveMacroFaces(children);
  const reverse = deriveMacroFaces([...children].reverse());

  assert.deepEqual(reverse, forward);
});

test("nested cluster compilation preserves CellInterface == ClusterInterface", () => {
  const innerNode = makeCell(
    "cluster-inner",
    0,
    0,
    "cluster-root",
    1,
    "cluster",
  );
  const innerChildren = radiusOne("cluster-inner", 2, "inner");
  const inner = compileCluster(innerNode, innerChildren, {
    childConnectionIds: ["inner-b", "inner-a"],
    summarizedStateRef: "state://inner",
  });

  assert.deepEqual(
    externalInterfaceFromCell(inner.node),
    externalInterfaceFromCluster(inner.cluster),
  );
  assert.deepEqual(inner.cluster.childConnectionIds, [
    "inner-a",
    "inner-b",
  ]);
  assert.equal(inner.cluster.summarizedStateRef, "state://inner");

  const outerNode = makeCell(
    "cluster-root",
    0,
    0,
    null,
    0,
    "cluster",
  );
  const outerRing = AXIAL_DIRECTIONS.map((direction, index) =>
    makeCell(
      `outer-${index}`,
      direction.q,
      direction.r,
      "cluster-root",
      1,
    ),
  );
  const outer = compileCluster(
    outerNode,
    [inner.node, ...outerRing],
    {
      childConnectionIds: ["root-connection"],
    },
  );

  assert.equal(outer.cluster.childNodeIds.includes("cluster-inner"), true);
  assert.deepEqual(
    externalInterfaceFromCell(outer.node),
    externalInterfaceFromCluster(outer.cluster),
  );
  assert.deepEqual(
    outer.cluster.macroFaces.map(
      (face) => face.exposedChildFaces.length,
    ),
    [3, 3, 3, 3, 3, 3],
  );
});

test("cluster compiler rejects a child from another parent scope", () => {
  const clusterNode = makeCell(
    "cluster-root",
    0,
    0,
    null,
    0,
    "cluster",
  );
  const child = makeCell("foreign", 0, 0, "other-cluster", 1);

  assert.throws(
    () => compileCluster(clusterNode, [child]),
    /does not belong to cluster/,
  );
});
