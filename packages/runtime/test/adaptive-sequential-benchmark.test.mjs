import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  checkpointExecutionFrame,
  createExecutionFrame,
  evaluateSequentialComputeBenchmark,
  mergeAdaptiveBranches,
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
  let completedRepetitions = 0;
  let qualityTotal = 0;
  let executedSteps = 0;

  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const started = performance.now();
    const branches = [];

    for (let branch = 0; branch < width; branch += 1) {
      const frame = createExecutionFrame(
        `g230-${depth}-${width}-${repetition}-${branch}`,
        "payload:g230-bench",
        { evidence: 0 },
        8,
      );
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
      const evidence = result.frame.residualState.evidence ?? 0;
      branches.push({
        id: `branch-${branch}`,
        quality: Math.min(1, evidence / 4),
        value: result.frame.residualState,
        exitCode: result.exitCode,
      });
      checkpointBytes += Buffer.byteLength(
        checkpointExecutionFrame(result.frame),
        "utf8",
      );
      executedSteps += result.frame.depth;
    }

    const merged = mergeAdaptiveBranches(
      {
        desiredDepth: depth,
        desiredWidth: width,
        branchJustified: width > 1,
      },
      branches,
      (left, right) => ({
        evidence: Math.max(left.evidence ?? 0, right.evidence ?? 0),
      }),
    );
    const mergedEvidence = merged.merged.evidence ?? 0;
    qualityTotal += Math.min(1, mergedEvidence / 4);
    completedRepetitions += branches.every(branch => branch.exitCode === "COMPLETED") ? 1 : 0;
    durations.push(performance.now() - started);
  }

  const activeClusters = 2 * width;
  const averageCheckpointBytes = checkpointBytes / repetitions;
  const totalElapsedMs = durations.reduce((sum, value) => sum + value, 0);
  return {
    depth,
    width,
    quality: qualityTotal / repetitions,
    completionRate: completedRepetitions / repetitions,
    activeClusters,
    ramBytes: Math.ceil(averageCheckpointBytes),
    p95LatencyMs: p95(durations),
    cost: executedSteps / repetitions,
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
  assert.ok(verdict.selected.ramBytes < baseline.ramBytes);

  console.log("G230_SEQUENTIAL_BENCHMARK", JSON.stringify({
    methodology: {
      repetitions: 80,
      physicalCorridorClustersPerBranch: 2,
      baseline: { depth: 4, width: 2 },
      quality: "merged residual evidence / target evidence",
      cost: "measured executed virtual steps per repetition",
      ramProxy: "serialized execution-frame bytes across actually executed branches",
      latency: "wall-clock sequential branch execution; conservative for potential parallel width",
    },
    rows,
    verdict,
  }));
});

test("no same-quality lower-cluster candidate fails safely to default topology", () => {
  const rows = [
    {
      depth: 2, width: 1, quality: 0.5, completionRate: 1,
      activeClusters: 2, ramBytes: 200, p95LatencyMs: 1,
      cost: 2, throughputPerSecond: 100,
    },
    {
      depth: 4, width: 2, quality: 1, completionRate: 1,
      activeClusters: 4, ramBytes: 500, p95LatencyMs: 2,
      cost: 8, throughputPerSecond: 80,
    },
  ];
  const verdict = evaluateSequentialComputeBenchmark(
    rows,
    { depth: 4, width: 2 },
    { qualityTolerance: 0, maxLatencyMs: 10, maxCost: 8 },
  );
  assert.equal(verdict.sameQualityFewerClustersProven, false);
  assert.equal(verdict.selected, null);
  assert.equal(verdict.verdict, "DEFAULT_TOPOLOGY");
});


test("same-quality lower-cluster candidate over latency ceiling fails closed", () => {
  const rows = [
    {
      depth: 4, width: 1, quality: 1, completionRate: 1,
      activeClusters: 2, ramBytes: 250, p95LatencyMs: 50,
      cost: 4, throughputPerSecond: 20,
    },
    {
      depth: 4, width: 2, quality: 1, completionRate: 1,
      activeClusters: 4, ramBytes: 500, p95LatencyMs: 10,
      cost: 8, throughputPerSecond: 40,
    },
  ];
  const verdict = evaluateSequentialComputeBenchmark(
    rows,
    { depth: 4, width: 2 },
    { qualityTolerance: 0, maxLatencyMs: 20, maxCost: 8 },
  );
  assert.equal(verdict.sameQualityFewerClustersProven, false);
  assert.equal(verdict.selected, null);
  assert.equal(verdict.verdict, "DEFAULT_TOPOLOGY");
});
