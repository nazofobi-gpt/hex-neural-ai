import test from "node:test";
import assert from "node:assert/strict";
import {
  checkpointExecutionFrame,
  createExecutionFrame,
  restoreExecutionFrame,
  runSequentialCorridor,
  validateSequentialCorridor,
} from "../dist/index.js";

const corridor = {
  clusters: [
    { id: "A", nextClusterId: "B" },
    { id: "B", nextClusterId: "A" },
  ],
  maxDepth: 8,
  maxRevisitsPerCluster: 4,
};

const processor = (clusterId, frame) => ({
  progress: 1,
  residualDelta: { score: (frame.residualState.score ?? 0) + (clusterId === "A" ? 1 : 2) },
});

test("two physical clusters produce deterministic 1/2/4/8 virtual passes", () => {
  assert.deepEqual(validateSequentialCorridor(corridor), []);
  for (const depth of [1, 2, 4, 8]) {
    const frame = createExecutionFrame("frame", "payload:sha256", { score: 0 }, 8);
    const one = runSequentialCorridor(corridor, frame, depth, processor);
    const two = runSequentialCorridor(corridor, frame, depth, processor);
    assert.equal(one.exitCode, "COMPLETED");
    assert.equal(one.frame.depth, depth);
    assert.deepEqual(one, two);
    assert.deepEqual(one.frame.trace, Array.from({ length: depth }, (_, i) => i % 2 ? "B" : "A"));
  }
});

test("payload reference stays separate while residual working state advances", () => {
  const frame = createExecutionFrame("isolation", "payload:immutable", { score: 0 }, 4);
  const result = runSequentialCorridor(corridor, frame, 4, processor);
  assert.equal(result.frame.payloadRef, "payload:immutable");
  assert.equal(result.frame.residualState.score, 6);
  assert.equal(frame.residualState.score, 0);
  assert.equal(frame.trace.length, 0);
});

test("checkpoint/restart preserves exact deterministic continuation state", () => {
  const first = runSequentialCorridor(corridor, createExecutionFrame("restart", "payload:x", { score: 0 }, 8), 2, processor);
  const restored = restoreExecutionFrame(checkpointExecutionFrame(first.frame));
  assert.deepEqual(restored, first.frame);
  const resumed = runSequentialCorridor(corridor, restored, 2, processor);
  assert.equal(resumed.frame.depth, 4);
  assert.equal(resumed.frame.payloadRef, "payload:x");
});

test("no-progress, ttl and revisit guards fail closed with typed exits", () => {
  const frame = createExecutionFrame("guards", "payload:x", {}, 8);
  assert.equal(runSequentialCorridor(corridor, frame, 8, () => ({ progress: 0 })).exitCode, "NO_PROGRESS");
  const shortTtl = createExecutionFrame("ttl", "payload:x", {}, 1);
  assert.equal(runSequentialCorridor(corridor, shortTtl, 4, processor).exitCode, "TTL_EXPIRED");
  const tight = { ...corridor, maxRevisitsPerCluster: 1 };
  assert.equal(runSequentialCorridor(tight, frame, 4, processor).exitCode, "REVISIT_LIMIT");
});
