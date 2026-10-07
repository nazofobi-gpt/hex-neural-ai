import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateSequentialComputeBenchmark } from "../dist/index.js";

const workerPath = fileURLToPath(
  new URL("./adaptive-sequential-benchmark-worker.mjs", import.meta.url),
);

function measuredRow(depth, width, repetitions = 80) {
  const output = execFileSync(
    process.execPath,
    [workerPath, String(depth), String(width), String(repetitions)],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
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

  for (const row of rows) {
    assert.ok(Number.isSafeInteger(row.ramBytes) && row.ramBytes > 0);
    assert.ok(Number.isSafeInteger(row.heapUsedBytes) && row.heapUsedBytes > 0);
    assert.ok(Number.isSafeInteger(row.ramDeltaBytes) && row.ramDeltaBytes >= 0);
    assert.ok(Number.isSafeInteger(row.heapDeltaBytes) && row.heapDeltaBytes >= 0);
  }

  console.log("G230_SEQUENTIAL_BENCHMARK", JSON.stringify({
    methodology: {
      repetitions: 80,
      physicalCorridorClustersPerBranch: 2,
      isolatedWorkerPerShape: true,
      baseline: { depth: 4, width: 2 },
      quality: "merged residual evidence / target evidence",
      cost: "measured executed virtual steps per repetition",
      ram: "peak process.memoryUsage().rss while all branch frames remain strongly referenced",
      heap: "peak process.memoryUsage().heapUsed under the same condition",
      memoryDelta: "peak minus isolated-worker post-import baseline; allocator/GC/OS noise explicitly retained",
      latency: "wall-clock sequential branch execution inside worker; conservative for potential parallel width",
    },
    rows,
    verdict,
  }));
});

test("no same-quality lower-cluster candidate fails safely to default topology", () => {
  const rows = [
    {
      depth: 2, width: 1, quality: 0.5, completionRate: 1,
      activeClusters: 2, ramBytes: 50_000_000, heapUsedBytes: 5_000_000,
      ramDeltaBytes: 1_000_000, heapDeltaBytes: 500_000,
      p95LatencyMs: 1, cost: 2, throughputPerSecond: 100,
    },
    {
      depth: 4, width: 2, quality: 1, completionRate: 1,
      activeClusters: 4, ramBytes: 51_000_000, heapUsedBytes: 5_500_000,
      ramDeltaBytes: 2_000_000, heapDeltaBytes: 1_000_000,
      p95LatencyMs: 2, cost: 8, throughputPerSecond: 80,
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
      activeClusters: 2, ramBytes: 50_000_000, heapUsedBytes: 5_000_000,
      ramDeltaBytes: 1_000_000, heapDeltaBytes: 500_000,
      p95LatencyMs: 50, cost: 4, throughputPerSecond: 20,
    },
    {
      depth: 4, width: 2, quality: 1, completionRate: 1,
      activeClusters: 4, ramBytes: 51_000_000, heapUsedBytes: 5_500_000,
      ramDeltaBytes: 2_000_000, heapDeltaBytes: 1_000_000,
      p95LatencyMs: 10, cost: 8, throughputPerSecond: 40,
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
