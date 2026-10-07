export interface AdaptiveComputeSignals {
  difficulty: number;
  novelty: number;
  uncertainty: number;
  disagreement: number;
}

export interface AdaptiveComputePolicy {
  branchThreshold: number;
  minMarginalGain: number;
  maxLatencyMs: number;
  maxCost: number;
  maxWidth: number;
}

export interface AdaptiveComputeState {
  depthBias: number;
  widthBias: number;
  version: number;
}

export interface AdaptiveComputeShape {
  desiredDepth: 1 | 2 | 4 | 8;
  desiredWidth: number;
  branchJustified: boolean;
}

function unit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function bounded(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

export function selectAdaptiveComputeShape(
  signals: AdaptiveComputeSignals,
  policy: AdaptiveComputePolicy,
  state: AdaptiveComputeState,
): AdaptiveComputeShape {
  const complexity = unit(
    (
      unit(signals.difficulty) +
      unit(signals.novelty) +
      unit(signals.uncertainty) +
      unit(signals.disagreement)
    ) / 4 + state.depthBias * 0.2,
  );
  const desiredDepth: 1 | 2 | 4 | 8 =
    complexity < 0.25 ? 1 :
    complexity < 0.5 ? 2 :
    complexity < 0.75 ? 4 : 8;
  const branchSignal = Math.min(
    unit(signals.uncertainty),
    unit(signals.disagreement),
  ) + state.widthBias * 0.2;
  const branchJustified =
    desiredDepth >= 4 &&
    branchSignal >= policy.branchThreshold &&
    policy.maxWidth > 1;
  return {
    desiredDepth,
    desiredWidth: branchJustified ? Math.min(2, policy.maxWidth) : 1,
    branchJustified,
  };
}

export function shouldContinueAdaptiveCompute(input: {
  previousQuality: number;
  currentQuality: number;
  elapsedMs: number;
  cost: number;
  policy: AdaptiveComputePolicy;
}): boolean {
  const gain = input.currentQuality - input.previousQuality;
  return (
    Number.isFinite(gain) &&
    gain >= input.policy.minMarginalGain &&
    input.elapsedMs <= input.policy.maxLatencyMs &&
    input.cost <= input.policy.maxCost
  );
}

export function updateAdaptiveComputeState(
  current: AdaptiveComputeState,
  reward: number,
  usedDepth: number,
  usedWidth: number,
  learningRate: number,
): AdaptiveComputeState {
  const boundedReward = bounded(reward);
  const rate = Math.max(0, Math.min(1, learningRate));
  const depthSignal = Math.max(0, Math.min(1, usedDepth / 8));
  const widthSignal = Math.max(0, Math.min(1, (usedWidth - 1) / 3));
  return {
    depthBias: bounded(current.depthBias + rate * boundedReward * depthSignal),
    widthBias: bounded(current.widthBias + rate * boundedReward * widthSignal),
    version: current.version + 1,
  };
}

export interface AdaptiveBranchCandidate<T> {
  id: string;
  quality: number;
  value: T;
}

export interface AdaptiveBranchMerge<T> {
  usedBranchIds: readonly string[];
  merged: T;
}

export function mergeAdaptiveBranches<T>(
  shape: AdaptiveComputeShape,
  candidates: readonly AdaptiveBranchCandidate<T>[],
  merge: (left: T, right: T) => T,
): AdaptiveBranchMerge<T> {
  const width = shape.branchJustified ? shape.desiredWidth : 1;
  const selected = candidates
    .filter(candidate => Number.isFinite(candidate.quality))
    .sort((a, b) => b.quality - a.quality || a.id.localeCompare(b.id))
    .slice(0, width);

  if (selected.length < width || selected.length === 0) {
    throw new Error("ADAPTIVE_BRANCH_RESULT_MISSING");
  }

  return {
    usedBranchIds: selected.map(candidate => candidate.id),
    merged: selected
      .slice(1)
      .reduce((current, candidate) => merge(current, candidate.value), selected[0].value),
  };
}

export interface SequentialBenchmarkRow {
  depth: number;
  width: number;
  quality: number;
  completionRate: number;
  activeClusters: number;
  /** Actual peak process RSS observed in an isolated benchmark worker. */
  ramBytes: number;
  /** Actual peak V8 heapUsed observed in the same isolated worker. */
  heapUsedBytes: number;
  /** Peak RSS minus worker baseline; allocator/OS noise may affect this delta. */
  ramDeltaBytes: number;
  /** Peak heapUsed minus worker baseline; allocator/GC noise may affect this delta. */
  heapDeltaBytes: number;
  p95LatencyMs: number;
  cost: number;
  throughputPerSecond: number;
}

export interface SequentialBenchmarkVerdict {
  rows: readonly SequentialBenchmarkRow[];
  sameQualityFewerClustersProven: boolean;
  selected: SequentialBenchmarkRow | null;
  verdict: "ADAPTIVE_POLICY" | "DEFAULT_TOPOLOGY";
}

export function evaluateSequentialComputeBenchmark(
  rows: readonly SequentialBenchmarkRow[],
  baseline: { depth: number; width: number },
  limits: {
    qualityTolerance: number;
    maxLatencyMs: number;
    maxCost: number;
  },
): SequentialBenchmarkVerdict {
  const baselineRow = rows.find(
    row => row.depth === baseline.depth && row.width === baseline.width,
  );
  if (!baselineRow) throw new Error("SEQUENTIAL_BENCHMARK_BASELINE_MISSING");
  const valid = rows
    .filter(row =>
      row.quality >= baselineRow.quality - limits.qualityTolerance &&
      row.completionRate >= baselineRow.completionRate &&
      row.activeClusters < baselineRow.activeClusters &&
      row.p95LatencyMs <= limits.maxLatencyMs &&
      row.cost <= limits.maxCost,
    )
    .sort((a, b) =>
      a.activeClusters - b.activeClusters ||
      a.cost - b.cost ||
      a.p95LatencyMs - b.p95LatencyMs,
    );
  const selected = valid[0] ?? null;
  return {
    rows: structuredClone(rows),
    sameQualityFewerClustersProven: selected !== null,
    selected,
    verdict: selected ? "ADAPTIVE_POLICY" : "DEFAULT_TOPOLOGY",
  };
}
