import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { runAdaptationAcceptanceBenchmark } from "../dist/index.js";

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

test("immutable O1 eval measures gain, forgetting, latency, cost and entropy", () => {
  const oldContextEval = [1, 2, 3, 4].map(n => oldExample(`old-eval-${n}`));
  const newContextEval = [1, 2, 3, 4].map(n => newExample(`new-eval-${n}`));
  const training = [1, 2, 3, 4, 5, 6].map(n => newExample(`new-train-${n}`));
  const before = JSON.stringify({ oldContextEval, newContextEval });

  const result = runAdaptationAcceptanceBenchmark({
    evalSetId: "g228-immutable-eval-v1",
    replayCapacity: 3,
    training,
    oldContextEval,
    newContextEval,
    initialState,
    deterministicCandidateId: "a",
    maxOldContextAccuracyDrop: 0,
    clockMs: () => performance.now(),
  });

  assert.equal(JSON.stringify({ oldContextEval, newContextEval }), before);
  assert.equal(result.replaySize, 3);
  assert.equal(result.adaptationStepsToFirstCorrect, 3);
  assert.equal(result.oldContextAccuracyBefore, 1);
  assert.equal(result.oldContextAccuracyAfter, 1);
  assert.equal(result.oldContextAccuracyDrop, 0);
  assert.equal(result.forgettingGuardPass, true);
  assert.equal(result.adapted.routeAccuracy, 1);
  assert.equal(result.deterministic.routeAccuracy, 0.5);
  assert.equal(result.adapted.regret, 0);
  assert.ok(result.deterministic.regret > 0);
  assert.equal(result.adapted.calls, 8);
  assert.equal(result.deterministic.calls, 8);
  assert.ok(Number.isFinite(result.adapted.p95LatencyMs));
  assert.ok(Number.isFinite(result.deterministic.p95LatencyMs));
  assert.ok(Number.isFinite(result.adapted.totalCost));
  assert.ok(Number.isFinite(result.adapted.entropyBits));
  assert.ok(Number.isFinite(result.adapted.calibrationError));
  assert.equal(result.verdict, "ADAPTED_POLICY");

  console.log("G228_ADAPTATION_BENCHMARK", JSON.stringify({
    evalSetId: result.evalSetId,
    replayCapacity: result.replayCapacity,
    replaySize: result.replaySize,
    adaptationStepsToFirstCorrect: result.adaptationStepsToFirstCorrect,
    oldContextAccuracyBefore: result.oldContextAccuracyBefore,
    oldContextAccuracyAfter: result.oldContextAccuracyAfter,
    oldContextAccuracyDrop: result.oldContextAccuracyDrop,
    forgettingGuardPass: result.forgettingGuardPass,
    adapted: result.adapted,
    deterministic: result.deterministic,
    verdict: result.verdict,
  }));
});
