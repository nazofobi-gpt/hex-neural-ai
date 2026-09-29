import assert from "node:assert/strict";
import test from "node:test";
import { compareForPromotion, stableDatasetDigest } from "../dist/eval-center.js";

const metric = (value, sampleSize = 100, uncertainty = 0.02) => ({
  id: "quality", value, direction: "maximize", uncertainty, sampleSize,
  evaluator: { source: "golden-review", version: "1" },
});
const run = (value, sampleSize, uncertainty) => ({
  datasetVersion: "dataset-v1", fixtureVersion: "golden-v1", candidateVersion: String(value),
  metrics: [metric(value, sampleSize, uncertainty)],
});
const rules = [{ metricId: "quality", minimumSampleSize: 30, maxUncertainty: 0.05, minimumImprovement: 0.01 }];

test("promotion passes only with measured improvement", () => {
  assert.equal(compareForPromotion(run(0.8), run(0.83), rules).status, "PASS");
});

test("tiny sample and high uncertainty fail closed", () => {
  const decision = compareForPromotion(run(0.8), run(0.9, 5, 0.2), rules);
  assert.equal(decision.status, "BLOCK");
  assert.deepEqual(decision.reasons, ["sample-too-small:quality", "uncertainty-too-high:quality"]);
});

test("dataset digest is deterministic and order independent", () => {
  assert.equal(stableDatasetDigest(["b", "a"]), stableDatasetDigest(["a", "b"]));
});
