import { validateRegionTopology, type RegionTopology } from "./functional-region.js";

export interface RegionShard {
  shardId: string;
  regionId: string;
  stateVersion: number;
  stateRef: string;
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
  placements: readonly { shardId: string; regionId: string }[];
}

export type RegionMigrationError =
  | "STALE_OWNER"
  | "INVALID_CHECKPOINT"
  | "INVALID_TOPOLOGY"
  | "VERSION_UNCHANGED"
  | "INVALID_SHARD_STATE"
  | "SHARD_COVERAGE_MISMATCH"
  | "UNKNOWN_TARGET_REGION"
  | "CHECKPOINT_DIVERGED";

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
    if (
      !shard.shardId.trim() ||
      !shard.stateRef.trim() ||
      !Number.isSafeInteger(shard.stateVersion) ||
      shard.stateVersion < 0 ||
      sourceIds.has(shard.shardId) ||
      !current.topology.regions.some(region => region.id === shard.regionId)
    ) {
      return { ok: false, code: "INVALID_SHARD_STATE" };
    }
    sourceIds.add(shard.shardId);
  }

  const placements = new Map<string, string>();
  for (const placement of intent.placements) {
    if (!sourceIds.has(placement.shardId) || placements.has(placement.shardId)) {
      return { ok: false, code: "SHARD_COVERAGE_MISMATCH" };
    }
    placements.set(placement.shardId, placement.regionId);
  }
  if (placements.size !== sourceIds.size) {
    return { ok: false, code: "SHARD_COVERAGE_MISMATCH" };
  }

  const targetIds = new Set(intent.nextTopology.regions.map(region => region.id));
  if ([...placements.values()].some(regionId => !targetIds.has(regionId))) {
    return { ok: false, code: "UNKNOWN_TARGET_REGION" };
  }

  const after: RegionSnapshot = {
    topology: deepCopy(intent.nextTopology),
    ownerId: intent.nextOwnerId,
    ownerEpoch: current.ownerEpoch + 1,
    shards: current.shards.map(shard => ({
      ...deepCopy(shard),
      regionId: placements.get(shard.shardId)!,
    })),
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
