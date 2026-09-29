export type MetricDirection = "maximize" | "minimize";

export interface EvalMetric {
  readonly id: string;
  readonly value: number;
  readonly direction: MetricDirection;
  readonly uncertainty: number;
  readonly sampleSize: number;
  readonly evaluator: { readonly source: string; readonly version: string };
}

export interface EvalRun {
  readonly datasetVersion: string;
  readonly fixtureVersion: string;
  readonly candidateVersion: string;
  readonly metrics: readonly EvalMetric[];
}

export interface PromotionRule {
  readonly metricId: string;
  readonly minimumSampleSize: number;
  readonly maxUncertainty: number;
  readonly minimumImprovement: number;
}

export type PromotionDecision =
  | { readonly status: "PASS"; readonly evidence: readonly string[] }
  | { readonly status: "BLOCK"; readonly reasons: readonly string[] };

export function compareForPromotion(
  baseline: EvalRun,
  candidate: EvalRun,
  rules: readonly PromotionRule[],
): PromotionDecision {
  const reasons: string[] = [];
  const evidence: string[] = [];
  if (baseline.datasetVersion !== candidate.datasetVersion) reasons.push("dataset-version-mismatch");
  if (baseline.fixtureVersion !== candidate.fixtureVersion) reasons.push("fixture-version-mismatch");

  for (const rule of rules) {
    const before = baseline.metrics.find((metric) => metric.id === rule.metricId);
    const after = candidate.metrics.find((metric) => metric.id === rule.metricId);
    if (!before || !after) {
      reasons.push(`missing-metric:${rule.metricId}`);
      continue;
    }
    if (after.sampleSize < rule.minimumSampleSize) reasons.push(`sample-too-small:${rule.metricId}`);
    if (after.uncertainty > rule.maxUncertainty) reasons.push(`uncertainty-too-high:${rule.metricId}`);
    if (before.evaluator.source !== after.evaluator.source || before.evaluator.version !== after.evaluator.version) {
      reasons.push(`evaluator-provenance-mismatch:${rule.metricId}`);
    }
    const signedDelta = after.direction === "maximize"
      ? after.value - before.value
      : before.value - after.value;
    if (signedDelta < rule.minimumImprovement) reasons.push(`regression:${rule.metricId}`);
    else evidence.push(`${rule.metricId}:${signedDelta.toFixed(6)}`);
  }

  return reasons.length > 0 ? { status: "BLOCK", reasons } : { status: "PASS", evidence };
}

export function stableDatasetDigest(rows: readonly string[]): string {
  let hash = 2166136261;
  for (const row of [...rows].sort()) {
    for (let index = 0; index < row.length; index += 1) {
      hash ^= row.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
