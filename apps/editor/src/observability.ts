export type SourceHealth = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
export type HealthState = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
export type CostKind = "provider" | "model" | "tool" | "compute" | "storage" | "egress";

export type TelemetryValue<T> =
  | { state: "KNOWN"; value: T; source: string }
  | { state: "UNKNOWN"; reason: string; sourceHealth: SourceHealth };

export interface ObsCorrelationV1 {
  schema: "obs.v1";
  runId: string;
  clusterId?: string;
  replicaId?: string;
  generationId?: string;
  graphId?: string;
  messageId?: string;
  checkpointId?: string;
}

export interface RunMetricsV1 {
  queueAgeMs: TelemetryValue<number>;
  throughputPerSecond: TelemetryValue<number>;
  errorCount: TelemetryValue<number>;
  restartCount: TelemetryValue<number>;
  replayCount: TelemetryValue<number>;
}

export interface CostLineV1 {
  kind: CostKind;
  provider?: string;
  model?: string;
  estimatedUsd: TelemetryValue<number>;
  actualUsd: TelemetryValue<number>;
}

export interface LogEntryV1 {
  id: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  attributes: Record<string, unknown>;
}

export interface ObservabilitySnapshotV1 {
  correlation: ObsCorrelationV1;
  metrics: RunMetricsV1;
  costs: CostLineV1[];
  logs: LogEntryV1[];
}

export interface BudgetPolicyV1 {
  warningUsd: number;
  hardCapUsd: number;
  killSwitch: boolean;
  unknownCost: "BLOCK" | "WARN";
}

export interface BudgetDecision {
  decision: "ALLOW" | "WARN" | "BLOCK";
  reason: "WITHIN_BUDGET" | "WARNING_THRESHOLD" | "HARD_CAP" | "KILL_SWITCH" | "COST_UNKNOWN" | "INVALID_POLICY";
  totalUsd: TelemetryValue<number>;
}

export const known = <T>(value: T, source: string): TelemetryValue<T> => ({
  state: "KNOWN",
  value,
  source,
});

export const unknown = <T>(
  reason: string,
  sourceHealth: SourceHealth = "UNAVAILABLE",
): TelemetryValue<T> => ({
  state: "UNKNOWN",
  reason,
  sourceHealth,
});

function validUsd(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function effectiveCost(line: CostLineV1): TelemetryValue<number> {
  if (line.actualUsd.state === "KNOWN") {
    return validUsd(line.actualUsd.value)
      ? line.actualUsd
      : unknown(`Invalid measured USD cost for ${line.kind}`, "DEGRADED");
  }
  if (line.estimatedUsd.state === "KNOWN") {
    return validUsd(line.estimatedUsd.value)
      ? line.estimatedUsd
      : unknown(`Invalid estimated USD cost for ${line.kind}`, "DEGRADED");
  }
  return unknown(
    `No measured or estimated cost for ${line.kind}`,
    line.actualUsd.sourceHealth === "UNAVAILABLE" && line.estimatedUsd.sourceHealth === "UNAVAILABLE"
      ? "UNAVAILABLE"
      : "DEGRADED",
  );
}

export function aggregateCost(costs: CostLineV1[]): TelemetryValue<number> {
  if (costs.length === 0) return unknown("No cost lines; total cost is unmeasured.", "UNAVAILABLE");
  let total = 0;
  for (const line of costs) {
    const value = effectiveCost(line);
    if (value.state === "UNKNOWN") return value;
    total += value.value;
    if (!validUsd(total)) {
      return unknown("Cost aggregation overflowed the finite USD range", "DEGRADED");
    }
  }
  return known(total, "obs.v1:cost-aggregate");
}

export function evaluateBudget(costs: CostLineV1[], policy: BudgetPolicyV1): BudgetDecision {
  const totalUsd = aggregateCost(costs);
  if (policy?.killSwitch === true) return { decision: "BLOCK", reason: "KILL_SWITCH", totalUsd };
  if (
    !policy ||
    typeof policy.killSwitch !== "boolean" ||
    !validUsd(policy.warningUsd) ||
    !validUsd(policy.hardCapUsd) ||
    policy.warningUsd > policy.hardCapUsd ||
    (policy.unknownCost !== "BLOCK" && policy.unknownCost !== "WARN")
  ) {
    return { decision: "BLOCK", reason: "INVALID_POLICY", totalUsd };
  }
  if (totalUsd.state === "UNKNOWN") {
    return {
      decision: policy.unknownCost === "BLOCK" ? "BLOCK" : "WARN",
      reason: "COST_UNKNOWN",
      totalUsd,
    };
  }
  if (totalUsd.value >= policy.hardCapUsd) {
    return { decision: "BLOCK", reason: "HARD_CAP", totalUsd };
  }
  if (totalUsd.value >= policy.warningUsd) {
    return { decision: "WARN", reason: "WARNING_THRESHOLD", totalUsd };
  }
  return { decision: "ALLOW", reason: "WITHIN_BUDGET", totalUsd };
}

function metricNumber(value: TelemetryValue<number>): number | null {
  return value.state === "KNOWN" && Number.isFinite(value.value) && value.value >= 0
    ? value.value
    : null;
}

export function deriveHealth(metrics: RunMetricsV1): HealthState {
  const all = [metrics.queueAgeMs, metrics.throughputPerSecond, metrics.errorCount, metrics.restartCount, metrics.replayCount];
  if (all.some((value, index) => value.state === "KNOWN" &&
    (metricNumber(value) === null || (index >= 2 && !Number.isInteger(value.value))))) return "UNKNOWN";
  const essential = all.slice(0, 3);
  if (essential.some((value) => value.state === "UNKNOWN")) return "UNKNOWN";

  const errors = metricNumber(metrics.errorCount) ?? 0;
  const throughput = metricNumber(metrics.throughputPerSecond) ?? 0;
  const queueAge = metricNumber(metrics.queueAgeMs) ?? 0;
  const restarts = metricNumber(metrics.restartCount) ?? 0;
  const replays = metricNumber(metrics.replayCount) ?? 0;

  if (throughput <= 0 && (errors > 0 || queueAge >= 30_000)) return "UNHEALTHY";
  if (errors > 0 || queueAge >= 5_000 || restarts > 0 || replays > 0) return "DEGRADED";
  return "HEALTHY";
}

const REDACTED = "[REDACTED]";
const forbiddenKey = /(authorization|token|secret|password|credential|payload|prompt|requestbody|responsebody|rawbody)/i;
const sensitiveString = /(bearer\s+[a-z0-9._~+\/-]+=*|sk-[a-z0-9_-]{8,})/i;

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return sensitiveString.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return redactTelemetry(value as Record<string, unknown>);
  return value;
}

export function redactTelemetry(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      forbiddenKey.test(key) ? REDACTED : redactValue(value),
    ]),
  );
}

export function sanitizeLogEntry(entry: LogEntryV1): LogEntryV1 {
  return {
    ...entry,
    message: sensitiveString.test(entry.message) ? REDACTED : entry.message,
    attributes: redactTelemetry(entry.attributes),
  };
}

export function virtualizeLogWindow(
  entries: LogEntryV1[],
  start: number,
  requestedSize: number,
  maximumWindow = 200,
): LogEntryV1[] {
  const safeStart = Math.max(0, Math.trunc(start));
  const safeSize = Math.min(Math.max(0, Math.trunc(requestedSize)), Math.max(1, Math.trunc(maximumWindow)));
  return entries.slice(safeStart, safeStart + safeSize).map(sanitizeLogEntry);
}


export interface MeteredRuntimeTraceV1 {
  traceId: string;
  externalCalls: number;
  providerMeter?: { amountUsd: number; receiptId: string; source: string };
}

export interface RuntimeReceiptProjectionV1 {
  runId: string;
  graphId: string;
  checkpointId?: string;
  clusterId?: string;
  replicaId?: string;
  generationId?: string;
  messageId?: string;
  runtimeMs: number;
  processedSignals: number;
  costUnits: number;
  maxCostUnits: number | null;
  status: "completed" | "terminated";
  terminationCode: string;
  /** Actual runtime trace from a provider adapter, not a synthetic USD conversion. */
  providerTrace?: MeteredRuntimeTraceV1[];
}

export interface RuntimeUnitBudgetEvidenceV1 {
  measuredCostUnits: number;
  maxCostUnits: number | null;
  decision: "ALLOW" | "BLOCK" | "UNKNOWN";
  reason: "WITHIN_RUNTIME_BUDGET" | "MAX_COST_EXCEEDED" | "RUNTIME_BUDGET_UNKNOWN" | "RUNTIME_BUDGET_INVALID";
}

export interface RuntimeObservabilityProjectionV1 {
  snapshot: ObservabilitySnapshotV1;
  runtimeBudget: RuntimeUnitBudgetEvidenceV1;
}

const runtimeCostKinds: CostKind[] = [
  "provider",
  "model",
  "tool",
  "compute",
  "storage",
  "egress",
];

export function projectRuntimeReceipt(
  receipt: RuntimeReceiptProjectionV1,
): RuntimeObservabilityProjectionV1 {
  const throughput =
    receipt.runtimeMs > 0
      ? known(
          Number(
            (
              receipt.processedSignals /
              (receipt.runtimeMs / 1_000)
            ).toFixed(3),
          ),
          "g200:RunReceipt.totals",
        )
      : unknown<number>(
          "Run receipt has zero runtimeMs; throughput is not measurable.",
          "DEGRADED",
        );

  const costs = runtimeCostKinds.map<CostLineV1>((kind) => ({
    kind,
    estimatedUsd: unknown(
      `No estimated USD receipt for ${kind}; runtime costUnits are not currency.`,
      "UNAVAILABLE",
    ),
    actualUsd: unknown(
      `No actual USD receipt for ${kind}; runtime costUnits are not currency.`,
      "UNAVAILABLE",
    ),
  }));


  // Only a fully metered and uniquely referenced set of external calls
  // can expose an adapter-reported provider USD subtotal. Other costs
  // remain UNKNOWN; this does not claim a complete end-to-end invoice.
  const billable = (receipt.providerTrace ?? []).filter((event) => event.externalCalls > 0);
  if (billable.length > 0) {
    const seenReceipts = new Set<string>();
    let usd = 0;
    let metered = true;
    for (const event of billable) {
      const meter = event.providerMeter;
      if (!meter || !event.traceId || !Number.isFinite(meter.amountUsd) ||
          meter.amountUsd < 0 || !meter.receiptId?.trim() || !meter.source?.trim() ||
          seenReceipts.has(meter.receiptId)) {
        metered = false;
        break;
      }
      seenReceipts.add(meter.receiptId);
      usd += meter.amountUsd;
      if (!Number.isFinite(usd)) {
        metered = false;
        break;
      }
    }
    if (metered) {
      costs[0] = {
        ...costs[0],
        actualUsd: known(usd, "obs.v1:adapter-reported-provider-meter-receipts"),
      };
    }
  }

  const invalidRuntimeUnits = !Number.isFinite(receipt.costUnits) || receipt.costUnits < 0 ||
    (receipt.maxCostUnits !== null && (!Number.isFinite(receipt.maxCostUnits) || receipt.maxCostUnits < 0));
  const runtimeBudget: RuntimeUnitBudgetEvidenceV1 =
    invalidRuntimeUnits
      ? {
          measuredCostUnits: receipt.costUnits,
          maxCostUnits: receipt.maxCostUnits,
          decision: "BLOCK",
          reason: "RUNTIME_BUDGET_INVALID",
        }
      : receipt.maxCostUnits === null
      ? {
          measuredCostUnits: receipt.costUnits,
          maxCostUnits: null,
          decision: "UNKNOWN",
          reason: "RUNTIME_BUDGET_UNKNOWN",
        }
      : receipt.terminationCode === "MAX_COST_EXCEEDED" ||
          receipt.costUnits > receipt.maxCostUnits
        ? {
            measuredCostUnits: receipt.costUnits,
            maxCostUnits: receipt.maxCostUnits,
            decision: "BLOCK",
            reason: "MAX_COST_EXCEEDED",
          }
        : {
            measuredCostUnits: receipt.costUnits,
            maxCostUnits: receipt.maxCostUnits,
            decision: "ALLOW",
            reason: "WITHIN_RUNTIME_BUDGET",
          };

  return {
    snapshot: {
      correlation: {
        schema: "obs.v1",
        runId: receipt.runId,
        clusterId: receipt.clusterId,
        replicaId: receipt.replicaId,
        generationId: receipt.generationId,
        graphId: receipt.graphId,
        messageId: receipt.messageId,
        checkpointId: receipt.checkpointId,
      },
      metrics: {
        queueAgeMs: unknown(
          "G-200 RunReceipt does not record queue-age samples.",
          "DEGRADED",
        ),
        throughputPerSecond: throughput,
        errorCount: known(
          receipt.status === "completed" ? 0 : 1,
          "g200:RunReceipt.status",
        ),
        restartCount: unknown(
          "G-200 RunReceipt does not record restart count.",
          "DEGRADED",
        ),
        replayCount: unknown(
          "G-200 RunReceipt does not record replay count.",
          "DEGRADED",
        ),
      },
      costs,
      logs: [],
    },
    runtimeBudget,
  };
}
