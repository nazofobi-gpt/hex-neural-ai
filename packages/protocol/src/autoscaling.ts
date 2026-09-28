export type ReplicaCount = 1 | 2 | 4 | 8;

export interface ScaleSample {
  replicas: ReplicaCount;
  throughputPerSecond: number;
  p95LatencyMs: number;
  inputRatePerSecond: number;
  networkBytesPerSecond: number;
  costPerHour: number;
  queueDepth: number;
  recoveryRegression: boolean;
}

export interface AutoscalePolicy {
  maxReplicas: ReplicaCount;
  maxQueueDepth: number;
  maxCostPerHour: number;
  scaleUpQueueDepth: number;
  scaleDownQueueDepth: number;
  cooldownMs: number;
  minEfficiency: number;
}

export interface ScaleDecision {
  replicas: ReplicaCount;
  reason: string;
}

const MATRIX: ReplicaCount[] = [1, 2, 4, 8];

export function scalingEfficiency(sample: ScaleSample, baseline: ScaleSample): number {
  if (sample.replicas === 1) return 1;
  if (baseline.throughputPerSecond <= 0) return 0;
  return sample.throughputPerSecond / baseline.throughputPerSecond / sample.replicas;
}

export function chooseUsefulTopology(samples: readonly ScaleSample[], minEfficiency: number): ScaleSample {
  if (!samples.length) throw new Error("samples required");
  const baseline = samples.find((s) => s.replicas === 1);
  if (!baseline) throw new Error("1-replica baseline required");
  const safe = samples.filter((s) =>
    !s.recoveryRegression &&
    Number.isFinite(s.costPerHour) &&
    s.costPerHour >= 0 &&
    scalingEfficiency(s, baseline) >= minEfficiency
  );
  if (!safe.length) return baseline;
  return safe.reduce((best, candidate) => {
    const bestValue = best.throughputPerSecond / Math.max(best.costPerHour, Number.EPSILON);
    const candidateValue = candidate.throughputPerSecond / Math.max(candidate.costPerHour, Number.EPSILON);
    return candidateValue > bestValue ? candidate : best;
  });
}

export function decideReplicaCount(
  current: ReplicaCount,
  sample: ScaleSample,
  policy: AutoscalePolicy,
  elapsedSinceScaleMs: number,
): ScaleDecision {
  if (sample.recoveryRegression) return { replicas: 1, reason: "recovery-regression" };
  if (sample.costPerHour > policy.maxCostPerHour) return { replicas: 1, reason: "budget-ceiling" };
  if (sample.queueDepth > policy.maxQueueDepth) return { replicas: 1, reason: "bounded-buffer-kill-switch" };
  if (elapsedSinceScaleMs < policy.cooldownMs) return { replicas: current, reason: "cooldown" };

  const index = MATRIX.indexOf(current);
  if (sample.queueDepth >= policy.scaleUpQueueDepth && current < policy.maxReplicas) {
    return { replicas: MATRIX[Math.min(index + 1, MATRIX.indexOf(policy.maxReplicas))], reason: "queue-pressure" };
  }
  if (sample.queueDepth <= policy.scaleDownQueueDepth && index > 0) {
    return { replicas: MATRIX[index - 1], reason: "safe-scale-down" };
  }
  return { replicas: current, reason: "hold" };
}

export function shardByLocality<T>(
  items: readonly T[],
  replicas: ReplicaCount,
  localityKey: (item: T) => number,
): T[][] {
  const shards = Array.from({ length: replicas }, () => [] as T[]);
  for (const item of items) {
    const key = localityKey(item);
    const slot = ((key % replicas) + replicas) % replicas;
    shards[slot].push(item);
  }
  return shards;
}

export function benchmarkMatrix(samples: readonly ScaleSample[]) {
  const baseline = samples.find((s) => s.replicas === 1);
  if (!baseline) throw new Error("1-replica baseline required");
  return samples.map((sample) => ({
    replicas: sample.replicas,
    throughputPerSecond: sample.throughputPerSecond,
    p95LatencyMs: sample.p95LatencyMs,
    scalingEfficiency: scalingEfficiency(sample, baseline),
    networkBytesPerSecond: sample.networkBytesPerSecond,
    costPerHour: sample.costPerHour,
    recoveryRegression: sample.recoveryRegression,
  }));
}
