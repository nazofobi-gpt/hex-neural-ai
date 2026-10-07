import {
  flatDeterministicFallback,
  routeRegionLocalFirst,
  validateRegionTopology,
  type RegionTopology,
} from "./functional-region.js";

export interface RegionShard {
  shardId: string;
  regionId: string;
  stateVersion: number;
  stateRef: string;
  /** Read-only replicas; authoritative writes remain fenced by RegionSnapshot.ownerId/ownerEpoch. */
  replicaOwnerIds?: readonly string[];
}

export interface RegionSnapshot {
  topology: RegionTopology;
  ownerId: string;
  ownerEpoch: number;
  shards: readonly RegionShard[];
}

export interface RegionMigrationIntent {
  checkpointId: string;
  expectedOwnerId: string;
  expectedOwnerEpoch: number;
  nextOwnerId: string;
  nextTopology: RegionTopology;
  placements: readonly {
    shardId: string;
    regionId: string;
    replicaOwnerIds?: readonly string[];
  }[];
}

export type RegionMigrationError =
  | "STALE_OWNER"
  | "INVALID_CHECKPOINT"
  | "INVALID_TOPOLOGY"
  | "VERSION_UNCHANGED"
  | "INVALID_SHARD_STATE"
  | "SHARD_COVERAGE_MISMATCH"
  | "UNKNOWN_TARGET_REGION"
  | "INVALID_REPLICA_PLACEMENT"
  | "CHECKPOINT_DIVERGED"
  | "INVALID_BENCHMARK"
  | "ROUTE_FAILED";

export interface PreparedRegionMigration {
  checkpointId: string;
  before: RegionSnapshot;
  after: RegionSnapshot;
}

export interface CommittedRegionMigration {
  checkpointId: string;
  before: RegionSnapshot;
  after: RegionSnapshot;
}

export type MigrationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RegionMigrationError };

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function identical(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeReplicaOwners(
  owners: readonly string[] | undefined,
): readonly string[] | null {
  if (!owners) return [];
  const normalized = owners.map(owner => owner.trim());
  if (
    normalized.some(owner => !owner) ||
    new Set(normalized).size !== normalized.length
  ) {
    return null;
  }
  return [...normalized].sort();
}

export function prepareRegionMigration(
  current: RegionSnapshot,
  intent: RegionMigrationIntent,
): MigrationResult<PreparedRegionMigration> {
  if (
    current.ownerId !== intent.expectedOwnerId ||
    current.ownerEpoch !== intent.expectedOwnerEpoch ||
    !Number.isSafeInteger(current.ownerEpoch) ||
    current.ownerEpoch < 0
  ) {
    return { ok: false, code: "STALE_OWNER" };
  }
  if (!intent.checkpointId.trim() || !intent.nextOwnerId.trim()) {
    return { ok: false, code: "INVALID_CHECKPOINT" };
  }
  if (
    validateRegionTopology(current.topology).length > 0 ||
    validateRegionTopology(intent.nextTopology).length > 0
  ) {
    return { ok: false, code: "INVALID_TOPOLOGY" };
  }
  if (intent.nextTopology.version === current.topology.version) {
    return { ok: false, code: "VERSION_UNCHANGED" };
  }

  const sourceIds = new Set<string>();
  for (const shard of current.shards) {
    const replicaOwners = normalizeReplicaOwners(shard.replicaOwnerIds);
    if (
      !shard.shardId.trim() ||
      !shard.stateRef.trim() ||
      !Number.isSafeInteger(shard.stateVersion) ||
      shard.stateVersion < 0 ||
      sourceIds.has(shard.shardId) ||
      !current.topology.regions.some(region => region.id === shard.regionId) ||
      replicaOwners === null
    ) {
      return {
        ok: false,
        code: replicaOwners === null
          ? "INVALID_REPLICA_PLACEMENT"
          : "INVALID_SHARD_STATE",
      };
    }
    sourceIds.add(shard.shardId);
  }

  const placements = new Map<string, {
    regionId: string;
    replicaOwnerIds: readonly string[];
  }>();
  for (const placement of intent.placements) {
    if (!sourceIds.has(placement.shardId) || placements.has(placement.shardId)) {
      return { ok: false, code: "SHARD_COVERAGE_MISMATCH" };
    }
    const replicaOwnerIds = normalizeReplicaOwners(placement.replicaOwnerIds);
    if (
      replicaOwnerIds === null ||
      replicaOwnerIds.includes(intent.nextOwnerId)
    ) {
      return { ok: false, code: "INVALID_REPLICA_PLACEMENT" };
    }
    placements.set(placement.shardId, {
      regionId: placement.regionId,
      replicaOwnerIds,
    });
  }
  if (placements.size !== sourceIds.size) {
    return { ok: false, code: "SHARD_COVERAGE_MISMATCH" };
  }

  const targetIds = new Set(intent.nextTopology.regions.map(region => region.id));
  if ([...placements.values()].some(placement => !targetIds.has(placement.regionId))) {
    return { ok: false, code: "UNKNOWN_TARGET_REGION" };
  }

  const after: RegionSnapshot = {
    topology: deepCopy(intent.nextTopology),
    ownerId: intent.nextOwnerId,
    ownerEpoch: current.ownerEpoch + 1,
    shards: current.shards.map(shard => {
      const placement = placements.get(shard.shardId)!;
      return {
        ...deepCopy(shard),
        regionId: placement.regionId,
        replicaOwnerIds: [...placement.replicaOwnerIds],
      };
    }),
  };
  return {
    ok: true,
    value: {
      checkpointId: intent.checkpointId,
      before: deepCopy(current),
      after,
    },
  };
}

export function commitRegionMigration(
  current: RegionSnapshot,
  prepared: PreparedRegionMigration,
): MigrationResult<CommittedRegionMigration> {
  if (
    current.ownerId !== prepared.before.ownerId ||
    current.ownerEpoch !== prepared.before.ownerEpoch
  ) {
    return { ok: false, code: "STALE_OWNER" };
  }
  if (!identical(current, prepared.before)) {
    return { ok: false, code: "CHECKPOINT_DIVERGED" };
  }
  return { ok: true, value: {
    checkpointId: prepared.checkpointId,
    before: deepCopy(prepared.before),
    after: deepCopy(prepared.after),
  } };
}

export function rollbackRegionMigration(
  current: RegionSnapshot,
  receipt: CommittedRegionMigration,
  expectedOwnerId: string,
  expectedOwnerEpoch: number,
): MigrationResult<RegionSnapshot> {
  if (
    current.ownerId !== expectedOwnerId ||
    current.ownerEpoch !== expectedOwnerEpoch
  ) {
    return { ok: false, code: "STALE_OWNER" };
  }
  if (!identical(current, receipt.after)) {
    return { ok: false, code: "CHECKPOINT_DIVERGED" };
  }
  return {
    ok: true,
    value: {
      topology: deepCopy(receipt.before.topology),
      ownerId: expectedOwnerId,
      ownerEpoch: current.ownerEpoch + 1,
      shards: deepCopy(receipt.before.shards),
    },
  };
}

export interface RegionRouteTelemetry {
  mode: "region" | "flat";
  regionIds: readonly string[];
  observedBandwidthBytes: number;
  observedLatencyMs: number;
  observedCostUnits: number;
  sampleId?: string;
  datasetId?: string;
}

export interface RouteBenchmarkMetrics {
  count: number;
  localHitCount: number;
  interRegionHops: number;
  bandwidthBytes: number;
  p95LatencyMs: number | null;
  totalCostUnits: number;
  maxRegionLoad: number;
  minRegionLoad: number;
}

function aggregate(samples: readonly RegionRouteTelemetry[]): RouteBenchmarkMetrics {
  const latencies = samples.map(s => s.observedLatencyMs).sort((a, b) => a - b);
  const loads = new Map<string, number>();
  for (const sample of samples) {
    for (const region of sample.regionIds) {
      loads.set(region, (loads.get(region) ?? 0) + 1);
    }
  }
  const loadValues = [...loads.values()];
  return {
    count: samples.length,
    localHitCount: samples.filter(s => s.regionIds.length === 1).length,
    interRegionHops: samples.reduce((sum, s) => sum + Math.max(0, s.regionIds.length - 1), 0),
    bandwidthBytes: samples.reduce((sum, s) => sum + s.observedBandwidthBytes, 0),
    p95LatencyMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
    totalCostUnits: samples.reduce((sum, s) => sum + s.observedCostUnits, 0),
    maxRegionLoad: loadValues.length ? Math.max(...loadValues) : 0,
    minRegionLoad: loadValues.length ? Math.min(...loadValues) : 0,
  };
}

/** Accepts observed measurements only. Synthetic fixtures cannot establish production gains. */
export function compareObservedRouteTelemetry(
  samples: readonly RegionRouteTelemetry[],
): MigrationResult<{ region: RouteBenchmarkMetrics; flat: RouteBenchmarkMetrics }> {
  if (samples.some(s =>
    !s.regionIds.length ||
    ![s.observedBandwidthBytes, s.observedLatencyMs, s.observedCostUnits]
      .every(v => Number.isFinite(v) && v >= 0)
  )) {
    return { ok: false, code: "INVALID_SHARD_STATE" };
  }
  return { ok: true, value: {
    region: aggregate(samples.filter(s => s.mode === "region")),
    flat: aggregate(samples.filter(s => s.mode === "flat")),
  } };
}


export interface RegionBenchmarkWorkloadSample {
  sampleId: string;
  sourceRegionId: string;
  targetRegionId: string;
  schema: string;
  payloadBytes: number;
}

export interface RegionBenchmarkCostModel {
  fixedCostUnits: number;
  perInterRegionHopCostUnits: number;
  perTransferredByteCostUnits: number;
}

export interface RegionBenchmarkProvenance {
  datasetId: string;
  source: string;
  capturedAt: string;
  repetitions: number;
  costModel: RegionBenchmarkCostModel;
}

export interface MatchedRegionBenchmarkResult {
  provenance: RegionBenchmarkProvenance;
  region: RouteBenchmarkMetrics;
  flat: RouteBenchmarkMetrics;
  telemetry: readonly RegionRouteTelemetry[];
}

/**
 * Executes the exact same bounded workload through local-first and flat routing.
 * Latency is clock-observed around the real routing call; bandwidth and cost are
 * derived from the route actually returned and the recorded payload/cost model.
 * The result reports measurements only and never asserts a topology benefit.
 */
export function benchmarkMatchedRegionVsFlat(
  topology: RegionTopology,
  workload: readonly RegionBenchmarkWorkloadSample[],
  provenance: RegionBenchmarkProvenance,
  clockMs: () => number,
): MigrationResult<MatchedRegionBenchmarkResult> {
  const cost = provenance.costModel;
  const costValues = [
    cost.fixedCostUnits,
    cost.perInterRegionHopCostUnits,
    cost.perTransferredByteCostUnits,
  ];
  if (
    validateRegionTopology(topology).length > 0 ||
    !provenance.datasetId.trim() ||
    !provenance.source.trim() ||
    !Number.isFinite(Date.parse(provenance.capturedAt)) ||
    !Number.isSafeInteger(provenance.repetitions) ||
    provenance.repetitions < 1 ||
    provenance.repetitions > 100_000 ||
    workload.length === 0 ||
    costValues.some(value => !Number.isFinite(value) || value < 0)
  ) {
    return { ok: false, code: "INVALID_BENCHMARK" };
  }

  const seen = new Set<string>();
  for (const sample of workload) {
    if (
      !sample.sampleId.trim() ||
      seen.has(sample.sampleId) ||
      !sample.schema.trim() ||
      !Number.isSafeInteger(sample.payloadBytes) ||
      sample.payloadBytes < 0
    ) {
      return { ok: false, code: "INVALID_BENCHMARK" };
    }
    seen.add(sample.sampleId);
  }

  const telemetry: RegionRouteTelemetry[] = [];
  for (const mode of ["region", "flat"] as const) {
    for (const sample of workload) {
      let route: readonly string[] | undefined;
      const started = clockMs();
      for (let attempt = 0; attempt < provenance.repetitions; attempt += 1) {
        const result = mode === "region"
          ? routeRegionLocalFirst(
              topology,
              sample.sourceRegionId,
              sample.targetRegionId,
              sample.schema,
            )
          : flatDeterministicFallback(
              topology,
              sample.sourceRegionId,
              sample.targetRegionId,
            );
        if (!result.ok) return { ok: false, code: "ROUTE_FAILED" };
        route = result.route.regionIds;
      }
      const finished = clockMs();
      const elapsed = finished - started;
      if (!Number.isFinite(elapsed) || elapsed < 0 || !route) {
        return { ok: false, code: "INVALID_BENCHMARK" };
      }

      const interRegionHops = Math.max(0, route.length - 1);
      const observedBandwidthBytes = sample.payloadBytes * interRegionHops;
      const observedCostUnits =
        cost.fixedCostUnits +
        cost.perInterRegionHopCostUnits * interRegionHops +
        cost.perTransferredByteCostUnits * observedBandwidthBytes;

      telemetry.push({
        mode,
        regionIds: [...route],
        observedBandwidthBytes,
        observedLatencyMs: elapsed / provenance.repetitions,
        observedCostUnits,
        sampleId: sample.sampleId,
        datasetId: provenance.datasetId,
      });
    }
  }

  const compared = compareObservedRouteTelemetry(telemetry);
  if (!compared.ok) return compared;
  return {
    ok: true,
    value: {
      provenance: deepCopy(provenance),
      region: compared.value.region,
      flat: compared.value.flat,
      telemetry,
    },
  };
}
