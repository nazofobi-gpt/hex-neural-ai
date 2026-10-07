import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { runGuardedAdaptationAcceptanceBenchmark } from "../dist/index.js";

const candidates = [{ id: "a", cost: 1 }, { id: "b", cost: 1.2 }];
const oldExample = id => ({
  id,
  context: { features: { old: 1, newer: 0 }, budget: 2, permissionTags: [] },
  candidates,
  expectedCandidateId: "a",
  rewards: { a: 1, b: -1 },
  cohort: "old",
});
const newExample = id => ({
  id,
  context: { features: { old: 0, newer: 1 }, budget: 2, permissionTags: [] },
  candidates,
  expectedCandidateId: "b",
  rewards: { a: -1, b: 1 },
  cohort: "new",
});
const initialState = {
  weights: {
    "candidate:a": 0.5,
    "candidate:b": 0,
    "a:old": 10,
    "a:newer": 1,
    "b:old": 0,
    "b:newer": 0,
  },
  eligibility: {},
  explorationRate: 0.1,
  maxExplorationRate: 0.2,
  stepSize: 0.5,
};

function run(oldContextEval, newContextEval, training, guard) {
  return runGuardedAdaptationAcceptanceBenchmark({
    evalSetId: "g228-guard-eval-v1",
    replayCapacity: 3,
    training,
    oldContextEval,
    newContextEval,
    initialState,
    deterministicCandidateId: "a",
    maxOldContextAccuracyDrop: 0,
    clockMs: () => performance.now(),
  }, guard);
}

test("accuracy gain is rejected when measured cost regresses", () => {
  const result = run(
    [1, 2].map(n => oldExample(`old-${n}`)),
    [1, 2].map(n => newExample(`new-${n}`)),
    [1, 2, 3, 4, 5, 6].map(n => newExample(`train-${n}`)),
    { maxP95LatencyRatio: 1000, maxCostRatio: 1 },
  );
  assert.equal(result.measuredGainPass, true);
  assert.equal(result.forgettingGuardPass, true);
  assert.equal(result.costGuardPass, false);
  assert.equal(result.verdict, "DETERMINISTIC_DEFAULT");
});

test("no measured accuracy gain always keeps deterministic default", () => {
  const result = run(
    [oldExample("old-a")],
    [oldExample("old-b")],
    [],
    { maxP95LatencyRatio: 1000, maxCostRatio: 2 },
  );
  assert.equal(result.measuredGainPass, false);
  assert.equal(result.verdict, "DETERMINISTIC_DEFAULT");
});

test("guarded verdict exposes latency and cost gate evidence", () => {
  const result = run(
    [oldExample("old-a")],
    [newExample("new-a")],
    [1, 2, 3, 4, 5, 6].map(n => newExample(`train-g-${n}`)),
    { maxP95LatencyRatio: 1, maxCostRatio: 1 },
  );
  assert.equal(typeof result.latencyGuardPass, "boolean");
  assert.equal(typeof result.costGuardPass, "boolean");
  console.log("G228_GUARDED_VERDICT", JSON.stringify({
    rawVerdict: result.rawVerdict,
    forgettingGuardPass: result.forgettingGuardPass,
    latencyGuardPass: result.latencyGuardPass,
    costGuardPass: result.costGuardPass,
    measuredGainPass: result.measuredGainPass,
    verdict: result.verdict,
    adapted: result.adapted,
    deterministic: result.deterministic,
  }));
});
