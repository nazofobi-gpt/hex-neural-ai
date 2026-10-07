import { performance } from "node:perf_hooks";
import {
  createExecutionFrame,
  mergeAdaptiveBranches,
  runSequentialCorridor,
} from "../dist/index.js";

const depth = Number.parseInt(process.argv[2] ?? "", 10);
const width = Number.parseInt(process.argv[3] ?? "", 10);
const repetitions = Number.parseInt(process.argv[4] ?? "80", 10);

if (![1, 2, 4, 8].includes(depth) || !Number.isSafeInteger(width) || width < 1 || width > 2) {
  throw new Error("INVALID_BENCHMARK_SHAPE");
}
if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
  throw new Error("INVALID_BENCHMARK_REPETITIONS");
}

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

const baselineMemory = process.memoryUsage();
let peakRssBytes = baselineMemory.rss;
let peakHeapUsedBytes = baselineMemory.heapUsed;
const durations = [];
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
      frame: result.frame,
      exitCode: result.exitCode,
    });
    executedSteps += result.frame.depth;
  }

  // Sample while all branch frames are still strongly referenced. This is an
  // actual process-level memory observation, not a serialized-state estimate.
  const memory = process.memoryUsage();
  peakRssBytes = Math.max(peakRssBytes, memory.rss);
  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);

  const merged = mergeAdaptiveBranches(
    { desiredDepth: depth, desiredWidth: width, branchJustified: width > 1 },
    branches,
    (left, right) => ({
      evidence: Math.max(left.evidence ?? 0, right.evidence ?? 0),
    }),
  );
  qualityTotal += Math.min(1, (merged.merged.evidence ?? 0) / 4);
  completedRepetitions += branches.every(branch => branch.exitCode === "COMPLETED") ? 1 : 0;
  durations.push(performance.now() - started);
}

const totalElapsedMs = durations.reduce((sum, value) => sum + value, 0);
process.stdout.write(JSON.stringify({
  depth,
  width,
  quality: qualityTotal / repetitions,
  completionRate: completedRepetitions / repetitions,
  activeClusters: 2 * width,
  ramBytes: peakRssBytes,
  heapUsedBytes: peakHeapUsedBytes,
  ramDeltaBytes: Math.max(0, peakRssBytes - baselineMemory.rss),
  heapDeltaBytes: Math.max(0, peakHeapUsedBytes - baselineMemory.heapUsed),
  p95LatencyMs: p95(durations),
  cost: executedSteps / repetitions,
  throughputPerSecond: totalElapsedMs > 0 ? repetitions / (totalElapsedMs / 1000) : 0,
  memoryBaseline: {
    rssBytes: baselineMemory.rss,
    heapUsedBytes: baselineMemory.heapUsed,
  },
}));
