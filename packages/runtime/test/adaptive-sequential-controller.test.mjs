import test from "node:test";
import assert from "node:assert/strict";
import {
  selectAdaptiveComputeShape,
  shouldContinueAdaptiveCompute,
  updateAdaptiveComputeState,
} from "../dist/index.js";

const policy = {
  branchThreshold: 0.6,
  minMarginalGain: 0.03,
  maxLatencyMs: 1000,
  maxCost: 100,
  maxWidth: 2,
};

test("controller scales depth first and branches only on justified uncertainty plus disagreement", () => {
  const state = { depthBias: 0, widthBias: 0, version: 1 };
  assert.deepEqual(
    selectAdaptiveComputeShape(
      { difficulty: 0.1, novelty: 0.1, uncertainty: 0.1, disagreement: 0.1 },
      policy,
      state,
    ),
    { desiredDepth: 1, desiredWidth: 1, branchJustified: false },
  );
  assert.deepEqual(
    selectAdaptiveComputeShape(
      { difficulty: 1, novelty: 1, uncertainty: 0.9, disagreement: 0.9 },
      policy,
      state,
    ),
    { desiredDepth: 8, desiredWidth: 2, branchJustified: true },
  );
  const noBranch = selectAdaptiveComputeShape(
    { difficulty: 1, novelty: 1, uncertainty: 0.9, disagreement: 0.1 },
    policy,
    state,
  );
  assert.equal(noBranch.desiredDepth, 8);
  assert.equal(noBranch.desiredWidth, 1);
  assert.equal(noBranch.branchJustified, false);
});

test("marginal gain, latency and cost ceilings stop compute independently", () => {
  const base = { previousQuality: 0.7, policy };
  assert.equal(shouldContinueAdaptiveCompute({ ...base, currentQuality: 0.75, elapsedMs: 10, cost: 4 }), true);
  assert.equal(shouldContinueAdaptiveCompute({ ...base, currentQuality: 0.71, elapsedMs: 10, cost: 4 }), false);
  assert.equal(shouldContinueAdaptiveCompute({ ...base, currentQuality: 0.8, elapsedMs: 1001, cost: 4 }), false);
  assert.equal(shouldContinueAdaptiveCompute({ ...base, currentQuality: 0.8, elapsedMs: 10, cost: 101 }), false);
});

test("bounded route-depth learner never leaves bias bounds", () => {
  let state = { depthBias: 0, widthBias: 0, version: 0 };
  for (let index = 0; index < 20; index += 1) {
    state = updateAdaptiveComputeState(state, 99, 8, 2, 1);
  }
  assert.equal(state.depthBias, 1);
  assert.equal(state.widthBias, 1);
  assert.equal(state.version, 20);
  for (let index = 0; index < 40; index += 1) {
    state = updateAdaptiveComputeState(state, -99, 8, 2, 1);
  }
  assert.equal(state.depthBias, -1);
  assert.equal(state.widthBias, -1);
  assert.equal(state.version, 60);
});
