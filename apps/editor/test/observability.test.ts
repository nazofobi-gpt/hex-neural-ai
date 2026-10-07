import { describe, expect, it } from "vitest";
import { runExecutableGraph, type ExecutableGraph } from "@hex-neural/runtime";
import {
  aggregateCost,
  deriveHealth,
  evaluateBudget,
  known,
  projectRuntimeReceipt,
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

  it("projects a real runtime receipt without treating cost units as USD", () => {
    const runtimeNode = (
      id: string,
      kind: ExecutableGraph["nodes"][number]["kind"],
      q: number,
    ): ExecutableGraph["nodes"][number] => ({
      id,
      kind,
      level: 0,
      parentId: null,
      coordinate: { q, r: 0 },
      faces: Array.from({ length: 6 }, (_, index) => ({
        index,
        semanticChannels: [],
        projectionPopulation: [],
        inputPolicy: "allow",
        outputPolicy: "allow",
        acceptedSchemas: [],
        connectionIds: [],
      })) as ExecutableGraph["nodes"][number]["faces"],
      neuralCircuitRef: null,
      config: {},
      stateRef: null,
      createdAt: "2026-10-07T14:00:00+02:00",
      updatedAt: "2026-10-07T14:00:00+02:00",
    });

    const executable: ExecutableGraph = {
      graphId: "obs-runtime",
      graphVersion: "v1",
      seed: 7,
      nodes: [
        runtimeNode("input", "input", 0),
        runtimeNode("tool", "tool", 1),
        runtimeNode("output", "output", 2),
      ],
      edges: [
        { id: "e1", sourceNodeId: "input", targetNodeId: "tool", bindings: [] },
        { id: "e2", sourceNodeId: "tool", targetNodeId: "output", bindings: [] },
      ],
      entryNodeIds: ["input"],
      outputNodeIds: ["output"],
      budget: {
        maxHops: 4,
        maxRuntimeMs: 100,
        maxExternalCalls: 1,
        maxCostUnits: 1,
      },
      policy: { allowedPermissions: ["tool.test"] },
    };

    const receipt = runExecutableGraph(executable, {
      runId: "runtime-budget-proof",
      startedAt: "2026-10-07T14:00:00+02:00",
      completedAt: "2026-10-07T14:00:01+02:00",
      initialPayloadRef: "artifact://private-input",
      initialSchema: null,
      traceId: "trace-runtime-budget",
      adapters: {
        byNodeId: {
          tool: {
            id: "tool.measured",
            execute: () => ({
              externalCalls: 1,
              costUnits: 2,
              durationMs: 4,
            }),
          },
        },
      },
    });

    expect(receipt.termination.code).toBe("MAX_COST_EXCEEDED");

    const projection = projectRuntimeReceipt({
      runId: receipt.runId,
      graphId: receipt.graphId,
      checkpointId: receipt.checkpoints.at(-1)?.id,
      clusterId: "cluster-1",
      replicaId: "local-1",
      generationId: "2",
      messageId: "m-1",
      runtimeMs: receipt.totals.runtimeMs,
      processedSignals: receipt.totals.processedSignals,
      costUnits: receipt.totals.costUnits,
      maxCostUnits: executable.budget.maxCostUnits,
      status: receipt.status,
      terminationCode: receipt.termination.code,
    });

    expect(projection.runtimeBudget).toEqual({
      measuredCostUnits: 2,
      maxCostUnits: 1,
      decision: "BLOCK",
      reason: "MAX_COST_EXCEEDED",
    });
    expect(projection.snapshot.correlation).toMatchObject({
      runId: "runtime-budget-proof",
      clusterId: "cluster-1",
      replicaId: "local-1",
      generationId: "2",
      graphId: "obs-runtime",
      messageId: "m-1",
    });
    expect(projection.snapshot.metrics.queueAgeMs.state).toBe("UNKNOWN");
    expect(projection.snapshot.costs).toHaveLength(6);
    expect(projection.snapshot.costs.every((line) => line.actualUsd.state === "UNKNOWN")).toBe(true);
    expect(evaluateBudget(projection.snapshot.costs, policy)).toMatchObject({
      decision: "BLOCK",
      reason: "COST_UNKNOWN",
    });
    expect(JSON.stringify(projection.snapshot)).not.toContain("artifact://private-input");
  });

});
