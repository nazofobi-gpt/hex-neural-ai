import test from "node:test";
import assert from "node:assert/strict";
import { proposeStructuralGrowth, resetBridgeFastState, selectBridgeCandidate, updateBridgePolicy } from "../dist/index.js";

const context = { features: { urgency: 1, novelty: 0.5 }, budget: 2, permissionTags: ["safe"] };
const candidates = [
  { id: "a", cost: 1, requiredPermission: "safe" },
  { id: "b", cost: 1 },
  { id: "blocked", cost: 1, requiredPermission: "admin" },
  { id: "expensive", cost: 3 },
];
const state = { weights: { "candidate:a": 0.5, "candidate:b": 0.1 }, eligibility: {}, explorationRate: 0.2, maxExplorationRate: 0.25, stepSize: 0.1 };

test("candidate filtering enforces permission and budget before selection", () => {
  const decision = selectBridgeCandidate(context, candidates, state, 0.9);
  assert.deepEqual(decision.allowedCandidateIds, ["a", "b"]);
  assert.equal(decision.candidateId, "a");
  assert.equal(decision.explored, false);
});

test("exploration is capped and deterministic from supplied unit", () => {
  const decision = selectBridgeCandidate(context, candidates, { ...state, explorationRate: 0.9 }, 0.1);
  assert.equal(decision.explored, true);
  assert.ok(["a", "b"].includes(decision.candidateId));
});

test("reward update is bounded and local to selected candidate eligibility", () => {
  const next = updateBridgePolicy(context, "a", 99, state);
  assert.equal(next.weights["candidate:a"], 0.6);
  assert.equal(next.weights["candidate:b"], 0.1);
  assert.equal(next.eligibility["a:urgency"], 1);
  assert.equal(next.eligibility["a:novelty"], 0.5);
});

test("no allowed candidate fails to deterministic fallback", () => {
  const decision = selectBridgeCandidate({ ...context, budget: 0 }, candidates, state, 0);
  assert.deepEqual(decision, { candidateId: null, explored: false, fallbackUsed: true, allowedCandidateIds: [] });
});

test("novelty only proposes structural growth and reset disables fast exploration", () => {
  assert.deepEqual(proposeStructuralGrowth(0.9, 0.8), { kind: "STRUCTURAL_GROWTH_PROPOSAL", reason: "novelty:0.9", mutatesTopology: false });
  assert.equal(resetBridgeFastState(state).explorationRate, 0);
});
