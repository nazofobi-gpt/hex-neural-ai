import test from "node:test";
import assert from "node:assert/strict";
import {
  BoundedReplayReservoir,
  commitRegionLearnerDelta,
  restartCommittedRegionLearner,
  serializeCommittedRegionLearner,
} from "../dist/index.js";

const candidates = [{ id: "a", cost: 1 }, { id: "b", cost: 1.2 }];
const example = id => ({
  id,
  context: { features: { x: 1 }, budget: 2, permissionTags: [] },
  candidates,
  expectedCandidateId: "a",
  rewards: { a: 1, b: -1 },
  cohort: "old",
});
const initialState = {
  weights: { "candidate:a": 0.5, "candidate:b": 0 },
  eligibility: {},
  explorationRate: 0.1,
  maxExplorationRate: 0.2,
  stepSize: 0.5,
};

test("bounded replay quota and duplicate replacement are deterministic", () => {
  const replay = new BoundedReplayReservoir(3);
  for (const id of ["one", "two", "three", "four"]) replay.push(example(id));
  assert.equal(replay.size, 3);
  assert.deepEqual(replay.snapshot().map(item => item.id), ["two", "three", "four"]);
  replay.push(example("three"));
  assert.deepEqual(replay.snapshot().map(item => item.id), ["two", "four", "three"]);
});

test("stale delta is rejected and restart preserves committed weights", () => {
  const current = {
    regionId: "association-a",
    ownerId: "worker-1",
    ownerEpoch: 7,
    version: 3,
    state: initialState,
  };
  const delta = {
    regionId: "association-a",
    ownerId: "worker-1",
    ownerEpoch: 7,
    baseVersion: 3,
    nextVersion: 4,
    nextState: {
      ...initialState,
      weights: { ...initialState.weights, "candidate:b": 0.75 },
      eligibility: { "candidate:b": 1 },
    },
  };
  const committed = commitRegionLearnerDelta(current, delta);
  assert.equal(committed.ok, true);
  assert.deepEqual(
    commitRegionLearnerDelta(current, { ...delta, ownerId: "other-worker" }),
    { ok: false, code: "STALE_DELTA_OWNER" },
  );
  assert.deepEqual(
    commitRegionLearnerDelta(committed.value, delta),
    { ok: false, code: "DELTA_VERSION_MISMATCH" },
  );
  const restarted = restartCommittedRegionLearner(
    serializeCommittedRegionLearner(committed.value),
  );
  assert.equal(restarted.version, 4);
  assert.equal(restarted.ownerEpoch, 7);
  assert.deepEqual(restarted.state.weights, committed.value.state.weights);
  assert.deepEqual(restarted.state.eligibility, {});
  assert.equal(restarted.state.explorationRate, 0);
});
