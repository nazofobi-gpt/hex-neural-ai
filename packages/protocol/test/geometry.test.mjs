import test from "node:test";
import assert from "node:assert/strict";
import { neighbor, isAdjacentOnFaces, OPPOSITE_FACE } from "../dist/geometry.js";

test("face 0 neighbor uses axial +q direction", () => {
  assert.deepEqual(neighbor({ q: 0, r: 0 }, 0), { q: 1, r: 0 });
});

test("opposite faces are symmetric", () => {
  for (const face of [0, 1, 2, 3, 4, 5]) {
    const opposite = OPPOSITE_FACE[face];
    assert.equal(OPPOSITE_FACE[opposite], face);
  }
});

test("adjacency requires both coordinate and opposing face", () => {
  assert.equal(isAdjacentOnFaces({ q: 0, r: 0 }, 0, { q: 1, r: 0 }, 3), true);
  assert.equal(isAdjacentOnFaces({ q: 0, r: 0 }, 0, { q: 1, r: 0 }, 2), false);
  assert.equal(isAdjacentOnFaces({ q: 0, r: 0 }, 0, { q: 2, r: 0 }, 3), false);
});
