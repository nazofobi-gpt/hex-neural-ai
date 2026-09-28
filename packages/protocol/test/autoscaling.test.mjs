import test from "node:test";
import assert from "node:assert/strict";
import {
  benchmarkMatrix,
  chooseUsefulTopology,
  decideReplicaCount,
  shardByLocality,
} from "../dist/autoscaling.js";

const samples = [
  { replicas: 1, throughputPerSecond: 100, p95LatencyMs: 80, inputRatePerSecond: 90, networkBytesPerSecond: 1000, costPerHour: 1, queueDepth: 4, recoveryRegression: false },
  { replicas: 2, throughputPerSecond: 185, p95LatencyMs: 48, inputRatePerSecond: 170, networkBytesPerSecond: 2400, costPerHour: 2, queueDepth: 3, recoveryRegression: false },
  { replicas: 4, throughputPerSecond: 310, p95LatencyMs: 38, inputRatePerSecond: 280, networkBytesPerSecond: 6200, costPerHour: 4, queueDepth: 2, recoveryRegression: false },
  { replicas: 8, throughputPerSecond: 360, p95LatencyMs: 36, inputRatePerSecond: 330, networkBytesPerSecond: 15100, costPerHour: 8, queueDepth: 1, recoveryRegression: false },
];

test("reports complete 1/2/4/8 benchmark matrix and honest efficiency", () => {
  const matrix = benchmarkMatrix(samples);
  assert.deepEqual(matrix.map((x) => x.replicas), [1, 2, 4, 8]);
  assert.equal(matrix[1].scalingEfficiency, 0.925);
  assert.equal(matrix[3].scalingEfficiency, 0.45);
});

test("eliminates topology without sufficient scaling benefit", () => {
  assert.equal(chooseUsefulTopology(samples, 0.7).replicas, 1);
});

test("bounds buffers and spend and safely scales down", () => {
  const policy = { maxReplicas: 8, maxQueueDepth: 100, maxCostPerHour: 10, scaleUpQueueDepth: 20, scaleDownQueueDepth: 5, cooldownMs: 1000, minEfficiency: 0.7 };
  assert.equal(decideReplicaCount(4, { ...samples[2], queueDepth: 101 }, policy, 2000).replicas, 1);
  assert.equal(decideReplicaCount(4, { ...samples[2], costPerHour: 11 }, policy, 2000).replicas, 1);
  assert.equal(decideReplicaCount(4, { ...samples[2], queueDepth: 2 }, policy, 2000).replicas, 2);
});

test("recovery regression fails closed and locality sharding is stable", () => {
  const policy = { maxReplicas: 8, maxQueueDepth: 100, maxCostPerHour: 10, scaleUpQueueDepth: 20, scaleDownQueueDepth: 5, cooldownMs: 1000, minEfficiency: 0.7 };
  assert.equal(decideReplicaCount(8, { ...samples[3], recoveryRegression: true }, policy, 2000).replicas, 1);
  const shards = shardByLocality([{ roi: 0 }, { roi: 4 }, { roi: 1 }], 4, (x) => x.roi);
  assert.deepEqual(shards[0], [{ roi: 0 }, { roi: 4 }]);
});
