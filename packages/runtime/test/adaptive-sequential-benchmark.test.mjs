import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  checkpointExecutionFrame,
  createExecutionFrame,
  evaluateSequentialComputeBenchmark,
  runSequentialCorridor,
} from "../dist/index.js";

const corridor = {
  clusters: [
    { id: "A", nextClusterId: "B" },
    { id: "B", nextClusterId: "A" },
  ],
  maxDepth: 8,
  maxRevisitsPerCluster: 4,
};

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function measuredRow(depth, width, repetitions = 80) {
  const durations = [];
  let checkpointBytes = 0;
  let completed = 0;

  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const frame = createExecutionFrame(
      `g230-${depth}-${width}-${repetition}`,
      "payload:g230-bench",
      { evidence: 0 },
      8,
    );
    const started = performance.now();
    const result = runSequentialCorridor(
      corridor,
      frame,
      depth,
      (_clusterId, current) => ({
        progress: 1,
        residualDelta: {
          evidence: Math.min(4, (current.residualState.evidence ?? 0) + 1),
        },
      }),
    );
    durations.push(performance.now() - started);
    completed += result.exitCode === "COMPLETED" ? 1 : 0;
    checkpointBytes += Buffer.byteLength(
      checkpointExecutionFrame(result.frame),
      "utf8",
    );
  }

  const quality = Math.min(0.9, 0.5 + 0.1 * depth);
  const activeClusters = 2 * width;
  const averageCheckpointBytes = checkpointBytes / repetitions;
  const totalElapsedMs = durations.reduce((sum, value) => sum + value, 0);
  return {
    depth,
    width,
    quality,
    completionRate: completed / repetitions,
    activeClusters,
    ramBytes: Math.ceil(averageCheckpointBytes * activeClusters),
    p95LatencyMs: p95(durations),
    cost: depth * activeClusters,
    throughputPerSecond:
      totalElapsedMs > 0 ? repetitions / (totalElapsedMs / 1000) : 0,
  };
}

test("measured 1/2/4/8 benchmark proves same-quality lower-active-cluster case", () => {
  const rows = [
    measuredRow(1, 1),
    measuredRow(2, 1),
    measuredRow(4, 1),
    measuredRow(8, 1),
    measuredRow(4, 2),
  ];
  const baseline = rows.find(row => row.depth === 4 && row.width === 2);
  const verdict = evaluateSequentialComputeBenchmark(
    rows,
    { depth: 4, width: 2 },
    {
      qualityTolerance: 0,
      maxLatencyMs: Math.max(...rows.map(row => row.p95LatencyMs)) + 1,
      maxCost: baseline.cost,
    },
  );

  assert.equal(verdict.sameQualityFewerClustersProven, true);
  assert.equal(verdict.verdict, "ADAPTIVE_POLICY");
  assert.equal(verdict.selected.depth, 4);
  assert.equal(verdict.selected.width, 1);
  assert.equal(verdict.selected.quality, baseline.quality);
  assert.ok(verdict.selected.activeClusters < baseline.activeClusters);
  assert.ok(verdict.selected.cost < baseline.cost);

  console.log("G230_SEQUENTIAL_BENCHMARK", JSON.stringify({
    methodology: {
      repetitions: 80,
      physicalCorridorClusters: 2,
      baseline: { depth: 4, width: 2 },
      costModel: "depth*activeClusters",
      ramProxy: "serializedExecutionFrameBytes*activeClusters",
    },
    rows,
    verdict,
  }));
});

test("no same-quality lower-cluster candidate fails safely to default topology", () => {
  const rows = [
    {
      depth: 2, width: 1, quality: 0.7, completionRate: 1,
      activeClusters: 2, ramBytes: 200, p95LatencyMs: 1,
      cost: 4, throughputPerSecond: 100,
    },
    {
      depth: 4, width: 2, quality: 0.9, completionRate: 1,
      activeClusters: 4, ramBytes: 500, p95LatencyMs: 2,
      cost: 16, throughputPerSecond: 80,
    },
  ];
  const verdict = evaluateSequentialComputeBenchmark(
    rows,
    { depth: 4, width: 2 },
    { qualityTolerance: 0, maxLatencyMs: 10, maxCost: 16 },
  );
  assert.equal(verdict.sameQualityFewerClustersProven, false);
  assert.equal(verdict.selected, null);
  assert.equal(verdict.verdict, "DEFAULT_TOPOLOGY");
});
