import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBufferRouteOutcome,
  bufferRouteExplorationWeight,
  checkpointBufferRingLearningState,
  createBufferRingLearningState,
  detectBufferRouteInstability,
  restoreBufferRingLearningState,
  rollbackBufferRingLearningState,
  selectBufferRoute,
} from "../dist/index.js";

const policy = {
  positiveStep: 0.25,
  wrongPenalty: 0.25,
  misinterpretPenalty: 0.2,
  unresolvedPenalty: 0.1,
  confusionPenalty: 0.2,
  minSamples: 4,
  quarantineSevereFailures: 3,
  hysteresisMargin: 0.35,
  explorationFloor: 0.05,
  instabilityThreshold: 2,
};

function applyMany(initial, events) {
  return events.reduce(
    (state, [routeId, outcome]) =>
      applyBufferRouteOutcome(state, [routeId], outcome, policy),
    initial,
  );
}

test("updates are eligibility-local, bounded, and do not learn hard policy", () => {
  const initial = createBufferRingLearningState(["route-a", "route-b", "route-c"]);
  const afterSuccess = applyBufferRouteOutcome(initial, ["route-b"], "SUCCESS", policy);
  assert.equal(afterSuccess.routes["route-b"].score, 0.25);
  assert.equal(afterSuccess.routes["route-b"].samples, 1);
  assert.deepEqual(afterSuccess.routes["route-a"], initial.routes["route-a"]);
  assert.deepEqual(afterSuccess.routes["route-c"], initial.routes["route-c"]);

  let saturated = afterSuccess;
  for (let index = 0; index < 20; index += 1) {
    saturated = applyBufferRouteOutcome(saturated, ["route-b"], "SUCCESS", policy);
  }
  assert.equal(saturated.routes["route-b"].score, 1);
  assert.equal(Object.hasOwn(saturated, "policy"), false);
  assert.equal(Object.hasOwn(saturated, "hardPolicy"), false);
});

test("minimum evidence blocks one-shot pruning and repeated severe failure quarantines locally", () => {
  let state = createBufferRingLearningState(["bad-route", "unrelated-route"]);
  state = applyBufferRouteOutcome(state, ["bad-route"], "WRONG", policy);
  assert.equal(state.routes["bad-route"].quarantined, false);
  assert.equal(state.routes["unrelated-route"].samples, 0);

  state = applyMany(state, [
    ["bad-route", "UNRESOLVED"],
    ["bad-route", "MISINTERPRETED"],
    ["bad-route", "CONFUSION"],
  ]);
  assert.equal(state.routes["bad-route"].samples, 4);
  assert.equal(state.routes["bad-route"].severeFailures, 3);
  assert.equal(state.routes["bad-route"].quarantined, true);
  assert.equal(bufferRouteExplorationWeight(state.routes["bad-route"], policy), 0);
  assert.equal(state.routes["unrelated-route"].samples, 0);
});

test("exploration floor survives non-severe decay", () => {
  let state = createBufferRingLearningState(["route-a"]);
  for (let index = 0; index < 20; index += 1) {
    state = applyBufferRouteOutcome(state, ["route-a"], "UNRESOLVED", policy);
  }
  assert.equal(state.routes["route-a"].score, -1);
  assert.equal(state.routes["route-a"].quarantined, false);
  assert.equal(bufferRouteExplorationWeight(state.routes["route-a"], policy), policy.explorationFloor);
});

test("confusion and oscillation are detected without global punishment", () => {
  let state = createBufferRingLearningState(["route-a", "route-b"]);
  state = applyMany(state, [
    ["route-a", "SUCCESS"],
    ["route-a", "WRONG"],
    ["route-a", "SUCCESS"],
  ]);
  assert.equal(state.routes["route-a"].oscillationCount, 2);
  assert.equal(detectBufferRouteInstability(state.routes["route-a"], policy), true);
  assert.equal(state.routes["route-b"].samples, 0);
  assert.equal(state.routes["route-b"].score, 0);
});

test("cold start stays neutral until minimum evidence and hysteresis justify specialization", () => {
  let state = createBufferRingLearningState(["route-default", "route-specialized"]);
  assert.deepEqual(
    selectBufferRoute(state, policy, "route-default"),
    { mode: "NEUTRAL", routeId: "route-default", score: 0 },
  );

  for (let index = 0; index < 3; index += 1) {
    state = applyBufferRouteOutcome(state, ["route-specialized"], "SUCCESS", policy);
  }
  assert.equal(selectBufferRoute(state, policy, "route-default").mode, "NEUTRAL");

  state = applyBufferRouteOutcome(state, ["route-specialized"], "SUCCESS", policy);
  assert.deepEqual(
    selectBufferRoute(state, policy, "route-default"),
    { mode: "SPECIALIZED", routeId: "route-specialized", score: 1 },
  );
});

test("checkpoint restart is exact and instability falls back until rollback restores stable route", () => {
  const initial = createBufferRingLearningState(["route-default", "route-specialized"]);
  const stable = applyMany(initial, [
    ["route-specialized", "SUCCESS"],
    ["route-specialized", "SUCCESS"],
    ["route-specialized", "SUCCESS"],
    ["route-specialized", "SUCCESS"],
  ]);
  const checkpoint = checkpointBufferRingLearningState(stable);
  const restored = restoreBufferRingLearningState(checkpoint);
  assert.deepEqual(restored, stable);
  assert.equal(selectBufferRoute(restored, policy, "route-default").mode, "SPECIALIZED");

  const unstable = applyMany(restored, [
    ["route-specialized", "WRONG"],
    ["route-specialized", "SUCCESS"],
  ]);
  assert.equal(detectBufferRouteInstability(unstable.routes["route-specialized"], policy), true);
  assert.deepEqual(
    selectBufferRoute(unstable, policy, "route-default"),
    { mode: "NEUTRAL", routeId: "route-default", score: 0 },
  );

  const rolledBack = rollbackBufferRingLearningState(checkpoint);
  assert.deepEqual(rolledBack, stable);
  assert.deepEqual(
    selectBufferRoute(rolledBack, policy, "route-default"),
    { mode: "SPECIALIZED", routeId: "route-specialized", score: 1 },
  );
});

test("recorded cold-start to stable-route benchmark converges with unrelated route untouched", () => {
  const initial = createBufferRingLearningState([
    "route-default",
    "route-specialized",
    "route-unrelated",
  ]);
  const cold = selectBufferRoute(initial, policy, "route-default");
  const targetRouteId = "route-specialized";
  const coldStartAccuracy = cold.routeId === targetRouteId ? 1 : 0;

  const events = [
    ["route-default", "WRONG"],
    ["route-specialized", "SUCCESS"],
    ["route-default", "UNRESOLVED"],
    ["route-specialized", "SUCCESS"],
    ["route-default", "MISINTERPRETED"],
    ["route-specialized", "SUCCESS"],
    ["route-default", "CONFUSION"],
    ["route-specialized", "SUCCESS"],
  ];
  const finalState = applyMany(initial, events);
  const stable = selectBufferRoute(finalState, policy, "route-default");
  const stableAccuracy = stable.routeId === targetRouteId ? 1 : 0;

  assert.equal(cold.mode, "NEUTRAL");
  assert.equal(coldStartAccuracy, 0);
  assert.equal(stable.mode, "SPECIALIZED");
  assert.equal(stable.routeId, targetRouteId);
  assert.equal(stableAccuracy, 1);
  assert.equal(finalState.routes["route-default"].quarantined, true);
  assert.equal(finalState.routes["route-specialized"].score, 1);
  assert.equal(finalState.routes["route-unrelated"].samples, 0);
  assert.equal(finalState.routes["route-unrelated"].score, 0);

  const checkpoint = checkpointBufferRingLearningState(finalState);
  assert.deepEqual(restoreBufferRingLearningState(checkpoint), finalState);

  console.log("G232_BUFFER_CONVERGENCE_BENCHMARK", JSON.stringify({
    methodology: {
      targetRouteId,
      deterministicFallbackRouteId: "route-default",
      recordedInteractions: events.length,
      minSamples: policy.minSamples,
      hysteresisMargin: policy.hysteresisMargin,
      quarantineSevereFailures: policy.quarantineSevereFailures,
      explorationFloor: policy.explorationFloor,
    },
    coldStart: {
      selection: cold,
      accuracy: coldStartAccuracy,
    },
    stable: {
      selection: stable,
      accuracy: stableAccuracy,
      defaultRoute: finalState.routes["route-default"],
      specializedRoute: finalState.routes["route-specialized"],
      unrelatedRoute: finalState.routes["route-unrelated"],
    },
    verdict: stableAccuracy > coldStartAccuracy ? "CONVERGED" : "NEUTRAL_FALLBACK",
  }));
});
