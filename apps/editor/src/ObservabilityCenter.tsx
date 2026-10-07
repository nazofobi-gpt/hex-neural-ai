import {
  deriveHealth,
  evaluateBudget,
  known,
  unknown,
  type CostLineV1,
  type ObservabilitySnapshotV1,
  type TelemetryValue,
} from "./observability";

const fixtureSource = "fixture://obs-preview-v1";

const preview: ObservabilitySnapshotV1 = {
  correlation: {
    schema: "obs.v1",
    runId: "preview-run-001",
    clusterId: "cluster-a",
    replicaId: "replica-2",
    generationId: "gen-17",
    graphId: "graph-preview",
    messageId: "msg-42",
    checkpointId: "cp-9",
  },
  metrics: {
    queueAgeMs: known(180, fixtureSource),
    throughputPerSecond: unknown("preview collector has no throughput sample", "DEGRADED"),
    errorCount: known(0, fixtureSource),
    restartCount: known(0, fixtureSource),
    replayCount: known(0, fixtureSource),
  },
  costs: [
    {
      kind: "provider",
      provider: "preview-provider",
      estimatedUsd: known(0.012, fixtureSource),
      actualUsd: known(0.011, fixtureSource),
    },
    {
      kind: "compute",
      estimatedUsd: known(0.004, fixtureSource),
      actualUsd: unknown("compute meter is not connected", "UNAVAILABLE"),
    },
  ],
  logs: [],
};

const budget = {
  warningUsd: 0.04,
  hardCapUsd: 0.05,
  killSwitch: false,
  unknownCost: "BLOCK" as const,
};

function valueText(value: TelemetryValue<number>, suffix = ""): string {
  return value.state === "KNOWN"
    ? `${value.value}${suffix} · ${value.source}`
    : `UNKNOWN · ${value.reason} · source ${value.sourceHealth.toLowerCase()}`;
}

function costText(line: CostLineV1): string {
  if (line.actualUsd.state === "KNOWN") {
    return `$${line.actualUsd.value.toFixed(3)} actual · ${line.actualUsd.source}`;
  }
  if (line.estimatedUsd.state === "KNOWN") {
    return `$${line.estimatedUsd.value.toFixed(3)} estimate · actual UNKNOWN`;
  }
  return `UNKNOWN · ${line.actualUsd.reason}`;
}

export function ObservabilityCenter() {
  const health = deriveHealth(preview.metrics);
  const decision = evaluateBudget(preview.costs, budget);

  return (
    <div className="content">
      <section className="capability-header">
        <div>
          <p className="eyebrow">Observability / obs.v1</p>
          <h2>Health, usage and cost controls</h2>
          <p>
            Preview fixture only. Missing telemetry stays UNKNOWN; it is never converted into a
            synthetic zero. Production payloads and credentials are not shown here.
          </p>
        </div>
        <span className="state-badge" data-testid="obs-health">{health}</span>
      </section>

      <section className="catalog" aria-label="Run correlation">
        <article>
          <div><strong>Run correlation</strong><span className="state-badge">fixture</span></div>
          <p>run {preview.correlation.runId} · graph {preview.correlation.graphId}</p>
          <small>
            generation {preview.correlation.generationId} · checkpoint {preview.correlation.checkpointId}
          </small>
        </article>
        <article>
          <div><strong>Distributed identity</strong><span className="state-badge">linked</span></div>
          <p>cluster {preview.correlation.clusterId} · replica {preview.correlation.replicaId}</p>
          <small>message {preview.correlation.messageId}</small>
        </article>
      </section>

      <section className="connection-card" aria-labelledby="telemetry-title">
        <div>
          <p className="eyebrow">Telemetry</p>
          <h3 id="telemetry-title">Source-aware metrics</h3>
        </div>
        <div className="permission-preview">
          <strong>Queue age</strong><span>{valueText(preview.metrics.queueAgeMs, " ms")}</span>
          <small>Collector values carry their source; UNKNOWN remains explicit.</small>
        </div>
        <div className="permission-preview">
          <strong>Throughput</strong><span data-testid="obs-throughput">{valueText(preview.metrics.throughputPerSecond, "/s")}</span>
          <small>No inferred throughput is displayed while the source is degraded.</small>
        </div>
        <div className="permission-preview">
          <strong>Errors / restarts / replays</strong>
          <span>
            {valueText(preview.metrics.errorCount)} / {valueText(preview.metrics.restartCount)} / {valueText(preview.metrics.replayCount)}
          </span>
          <small>Representative fixture counters, not production measurements.</small>
        </div>
      </section>

      <section className="connection-card" aria-labelledby="cost-title">
        <div>
          <p className="eyebrow">Cost governance</p>
          <h3 id="cost-title">Hard cap and kill switch</h3>
        </div>
        {preview.costs.map((line) => (
          <div className="permission-preview" key={line.kind}>
            <strong>{line.kind}</strong><span>{costText(line)}</span>
            <small>Actual cost wins over estimates when available.</small>
          </div>
        ))}
        <div className="permission-preview">
          <strong>Budget verdict</strong>
          <span data-testid="budget-verdict">{decision.decision} · {decision.reason}</span>
          <small>
            Hard cap {budget.hardCapUsd.toFixed(2)} USD · warning {budget.warningUsd.toFixed(2)} USD ·
            unknown-cost policy {budget.unknownCost}
          </small>
        </div>
      </section>
    </div>
  );
}
