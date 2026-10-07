import {
  runAdaptationAcceptanceBenchmark,
  type AdaptationBenchmarkInput,
  type AdaptationBenchmarkResult,
} from "./online-adaptation-benchmark.js";

export interface AdaptationRegressionGuard {
  readonly maxP95LatencyRatio: number;
  readonly maxCostRatio: number;
}

export interface GuardedAdaptationBenchmarkResult
  extends Omit<AdaptationBenchmarkResult, "verdict"> {
  readonly rawVerdict: AdaptationBenchmarkResult["verdict"];
  readonly latencyGuardPass: boolean;
  readonly costGuardPass: boolean;
  readonly measuredGainPass: boolean;
  readonly verdict: "ADAPTED_POLICY" | "DETERMINISTIC_DEFAULT";
}

export function runGuardedAdaptationAcceptanceBenchmark(
  input: AdaptationBenchmarkInput,
  guard: AdaptationRegressionGuard,
): GuardedAdaptationBenchmarkResult {
  if (
    !Number.isFinite(guard.maxP95LatencyRatio) ||
    guard.maxP95LatencyRatio < 0 ||
    !Number.isFinite(guard.maxCostRatio) ||
    guard.maxCostRatio < 0
  ) {
    throw new Error("ADAPTATION_REGRESSION_GUARD_INVALID");
  }

  const raw = runAdaptationAcceptanceBenchmark(input);
  const latencyGuardPass =
    raw.adapted.p95LatencyMs !== null &&
    raw.deterministic.p95LatencyMs !== null &&
    raw.adapted.p95LatencyMs <=
      raw.deterministic.p95LatencyMs * guard.maxP95LatencyRatio;
  const costGuardPass =
    raw.adapted.totalCost <= raw.deterministic.totalCost * guard.maxCostRatio;
  const measuredGainPass =
    raw.adapted.routeAccuracy > raw.deterministic.routeAccuracy &&
    raw.adapted.regret <= raw.deterministic.regret;
  const verdict =
    raw.forgettingGuardPass &&
    latencyGuardPass &&
    costGuardPass &&
    measuredGainPass
      ? "ADAPTED_POLICY"
      : "DETERMINISTIC_DEFAULT";

  return {
    ...raw,
    rawVerdict: raw.verdict,
    latencyGuardPass,
    costGuardPass,
    measuredGainPass,
    verdict,
  };
}
