import { describe, expect, it } from "vitest";
import {
  aggregateCost,
  deriveHealth,
  evaluateBudget,
  known,
  redactTelemetry,
  unknown,
  virtualizeLogWindow,
  type CostLineV1,
  type RunMetricsV1,
} from "../src/observability";

const policy = {
  warningUsd: 0.04,
  hardCapUsd: 0.05,
  killSwitch: false,
  unknownCost: "BLOCK" as const,
};

describe("obs.v1 telemetry semantics", () => {
  it("keeps missing telemetry UNKNOWN instead of inventing a numeric value", () => {
    const metrics: RunMetricsV1 = {
      queueAgeMs: unknown("collector has no queue sample", "DEGRADED"),
      throughputPerSecond: known(12, "fixture"),
      errorCount: known(0, "fixture"),
      restartCount: known(0, "fixture"),
      replayCount: known(0, "fixture"),
    };

    expect(metrics.queueAgeMs.state).toBe("UNKNOWN");
    expect(deriveHealth(metrics)).toBe("UNKNOWN");
  });

  it("uses measured cost before estimate and enforces the hard cap", () => {
    const costs: CostLineV1[] = [
      {
        kind: "provider",
        provider: "fixture-provider",
        estimatedUsd: known(0.02, "estimate"),
        actualUsd: known(0.03, "meter"),
      },
      {
        kind: "compute",
        estimatedUsd: known(0.01, "estimate"),
        actualUsd: unknown("meter pending", "DEGRADED"),
      },
    ];

    expect(aggregateCost(costs)).toEqual(known(0.04, "obs.v1:cost-aggregate"));
    expect(evaluateBudget(costs, policy)).toMatchObject({
      decision: "WARN",
      reason: "WARNING_THRESHOLD",
    });

    const overCap = costs.map((line, index) =>
      index === 0 ? { ...line, actualUsd: known(0.06, "meter") } : line,
    );
    expect(evaluateBudget(overCap, policy)).toMatchObject({
      decision: "BLOCK",
      reason: "HARD_CAP",
    });
  });

  it("fails closed when cost is unknown and honors the kill switch", () => {
    const costs: CostLineV1[] = [{
      kind: "tool",
      estimatedUsd: unknown("no estimator"),
      actualUsd: unknown("no meter"),
    }];

    expect(evaluateBudget(costs, policy)).toMatchObject({
      decision: "BLOCK",
      reason: "COST_UNKNOWN",
    });
    expect(evaluateBudget(costs, { ...policy, killSwitch: true })).toMatchObject({
      decision: "BLOCK",
      reason: "KILL_SWITCH",
    });
  });

  it("redacts credential, payload and bearer material recursively", () => {
    const redacted = redactTelemetry({
      runId: "run-1",
      credentialRef: "vault://workspace/key",
      payload: { private: "raw data" },
      nested: { authorization: "Bearer abcdef123456", safe: "ok" },
      message: "Bearer deadbeef1234",
    });

    expect(redacted).toEqual({
      runId: "run-1",
      credentialRef: "[REDACTED]",
      payload: "[REDACTED]",
      nested: { authorization: "[REDACTED]", safe: "ok" },
      message: "[REDACTED]",
    });
  });

  it("bounds large-log rendering windows and sanitizes returned entries", () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({
      id: `log-${index}`,
      level: "info" as const,
      message: "safe",
      attributes: { index, token: "secret-value" },
    }));

    const window = virtualizeLogWindow(entries, 120, 1_000);
    expect(window).toHaveLength(200);
    expect(window[0].id).toBe("log-120");
    expect(window[0].attributes.token).toBe("[REDACTED]");
  });
});
