import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  benchmarkMatchedRegionVsFlat,
  commitRegionMigration,
  compareObservedRouteTelemetry,
  prepareRegionMigration,
  rollbackRegionMigration,
} from "../dist/index.js";

const region = (id) => ({
  id, version: "1", kind: "association", semanticCentroid: [id],
  ports: [], childRegionIds: [],
});
const base = {
  topology: { version: "1", regions: [region("a"), region("b")], projections: [] },
  ownerId: "worker-1",
  ownerEpoch: 4,
  shards: [
    { shardId: "one", regionId: "a", stateVersion: 3, stateRef: "sha256:one" },
    { shardId: "two", regionId: "b", stateVersion: 8, stateRef: "sha256:two" },
  ],
};
const migration = {
  checkpointId: "checkpoint-1",
  expectedOwnerId: "worker-1",
  expectedOwnerEpoch: 4,
  nextOwnerId: "worker-2",
  nextTopology: {
    version: "2",
    regions: [region("a"), region("b"), region("c")],
    projections: [],
  },
  placements: [
    { shardId: "one", regionId: "c" },
    { shardId: "two", regionId: "b" },
  ],
};

test("checkpointed split/rebalance and owner transfer preserve shard versions and state refs", () => {
  const prepared = prepareRegionMigration(base, migration);
  assert.equal(prepared.ok, true);
  const committed = commitRegionMigration(base, prepared.value);
  assert.equal(committed.ok, true);
  assert.equal(committed.value.after.ownerId, "worker-2");
  assert.equal(committed.value.after.ownerEpoch, 5);
  assert.equal(committed.value.after.topology.version, "2");
  assert.deepEqual(
    committed.value.after.shards.map(s => [s.shardId, s.regionId, s.stateVersion, s.stateRef]),
    [["one", "c", 3, "sha256:one"], ["two", "b", 8, "sha256:two"]],
  );
  assert.equal(base.ownerEpoch, 4, "original checkpoint must remain unchanged");
});

test("stale owner, changed state and replay are fenced", () => {
  assert.deepEqual(
    prepareRegionMigration(base, { ...migration, expectedOwnerEpoch: 3 }),
    { ok: false, code: "STALE_OWNER" },
  );
  const prepared = prepareRegionMigration(base, migration).value;
  assert.deepEqual(
    commitRegionMigration({ ...base, ownerEpoch: 5 }, prepared),
    { ok: false, code: "STALE_OWNER" },
  );
  const divergent = { ...base, shards: base.shards.map(s => ({ ...s, stateRef: "changed" })) };
  assert.deepEqual(commitRegionMigration(divergent, prepared), { ok: false, code: "CHECKPOINT_DIVERGED" });
  const committed = commitRegionMigration(base, prepared).value;
  assert.deepEqual(
    commitRegionMigration(committed.after, prepared),
    { ok: false, code: "STALE_OWNER" },
  );
});

test("missing, duplicate, dangling shard placement and version reuse fail closed", () => {
  const badCases = [
    [{ ...migration, placements: migration.placements.slice(0, 1) }, "SHARD_COVERAGE_MISMATCH"],
    [{ ...migration, placements: [migration.placements[0], migration.placements[0]] }, "SHARD_COVERAGE_MISMATCH"],
    [{ ...migration, placements: [{ shardId: "one", regionId: "ghost" }, migration.placements[1]] }, "UNKNOWN_TARGET_REGION"],
    [{ ...migration, nextTopology: { ...migration.nextTopology, version: "1" } }, "VERSION_UNCHANGED"],
  ];
  for (const [intent, code] of badCases) {
    assert.deepEqual(prepareRegionMigration(base, intent), { ok: false, code });
  }
});

test("rollback restores topology and durable refs without returning old fencing epoch", () => {
  const prepared = prepareRegionMigration(base, migration).value;
  const committed = commitRegionMigration(base, prepared).value;
  const rolledBack = rollbackRegionMigration(committed.after, committed, "worker-2", 5);
  assert.equal(rolledBack.ok, true);
  assert.equal(rolledBack.value.topology.version, "1");
  assert.equal(rolledBack.value.ownerId, "worker-2");
  assert.equal(rolledBack.value.ownerEpoch, 6);
  assert.deepEqual(rolledBack.value.shards, base.shards);
  assert.deepEqual(
    rollbackRegionMigration(committed.after, committed, "worker-1", 4),
    { ok: false, code: "STALE_OWNER" },
  );
});

test("measured region/flat telemetry summaries remain explicit; no invented benefit", () => {
  const result = compareObservedRouteTelemetry([
    { mode: "region", regionIds: ["a"], observedBandwidthBytes: 100, observedLatencyMs: 7, observedCostUnits: 1 },
    { mode: "region", regionIds: ["a", "c"], observedBandwidthBytes: 200, observedLatencyMs: 9, observedCostUnits: 2 },
    { mode: "flat", regionIds: ["a", "b"], observedBandwidthBytes: 400, observedLatencyMs: 12, observedCostUnits: 4 },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    [result.value.region.count, result.value.region.localHitCount, result.value.region.interRegionHops, result.value.region.p95LatencyMs],
    [2, 1, 1, 9],
  );
  assert.equal(result.value.flat.bandwidthBytes, 400);
  assert.deepEqual(compareObservedRouteTelemetry([
    { mode: "flat", regionIds: ["a"], observedBandwidthBytes: -1, observedLatencyMs: 1, observedCostUnits: 0 },
  ]), { ok: false, code: "INVALID_SHARD_STATE" });
});


test("split then merge across authoritative owners migrates replicas without state drift", () => {
  const split = prepareRegionMigration(base, {
    ...migration,
    placements: [
      { shardId: "one", regionId: "c", replicaOwnerIds: ["worker-3", "worker-4"] },
      { shardId: "two", regionId: "b", replicaOwnerIds: ["worker-4"] },
    ],
  });
  assert.equal(split.ok, true);
  const first = commitRegionMigration(base, split.value);
  assert.equal(first.ok, true);
  assert.equal(first.value.after.ownerId, "worker-2");
  assert.equal(first.value.after.ownerEpoch, 5);

  const mergedTopology = {
    version: "3",
    regions: [region("b"), region("c")],
    projections: [],
  };
  const merge = prepareRegionMigration(first.value.after, {
    checkpointId: "checkpoint-2",
    expectedOwnerId: "worker-2",
    expectedOwnerEpoch: 5,
    nextOwnerId: "worker-3",
    nextTopology: mergedTopology,
    placements: [
      { shardId: "one", regionId: "c", replicaOwnerIds: ["worker-4"] },
      { shardId: "two", regionId: "b", replicaOwnerIds: ["worker-1"] },
    ],
  });
  assert.equal(merge.ok, true);
  const second = commitRegionMigration(first.value.after, merge.value);
  assert.equal(second.ok, true);
  assert.equal(second.value.after.ownerId, "worker-3");
  assert.equal(second.value.after.ownerEpoch, 6);
  assert.deepEqual(
    second.value.after.shards.map(s => [
      s.shardId,
      s.regionId,
      s.stateVersion,
      s.stateRef,
      s.replicaOwnerIds,
    ]),
    [
      ["one", "c", 3, "sha256:one", ["worker-4"]],
      ["two", "b", 8, "sha256:two", ["worker-1"]],
    ],
  );

  assert.deepEqual(
    prepareRegionMigration(second.value.after, {
      checkpointId: "stale",
      expectedOwnerId: "worker-2",
      expectedOwnerEpoch: 5,
      nextOwnerId: "worker-4",
      nextTopology: { ...mergedTopology, version: "4" },
      placements: [
        { shardId: "one", regionId: "c" },
        { shardId: "two", regionId: "b" },
      ],
    }),
    { ok: false, code: "STALE_OWNER" },
  );

  assert.deepEqual(
    prepareRegionMigration(base, {
      ...migration,
      placements: [
        { shardId: "one", regionId: "c", replicaOwnerIds: ["worker-3", "worker-3"] },
        { shardId: "two", regionId: "b" },
      ],
    }),
    { ok: false, code: "INVALID_REPLICA_PLACEMENT" },
  );
});

test("bounded matched benchmark records real route timings and exact workload provenance", () => {
  const topology = {
    version: "bench-1",
    regions: [region("a"), region("b"), region("c")],
    projections: [
      { fromRegionId: "a", toRegionId: "b", schema: "application/json", explicit: true },
      { fromRegionId: "b", toRegionId: "c", schema: "application/json", explicit: true },
      { fromRegionId: "a", toRegionId: "c", schema: "application/json", explicit: true },
    ],
  };
  const workload = [
    { sampleId: "local-a-1", sourceRegionId: "a", targetRegionId: "a", schema: "application/json", payloadBytes: 512 },
    { sampleId: "local-b-1", sourceRegionId: "b", targetRegionId: "b", schema: "application/json", payloadBytes: 1024 },
    { sampleId: "a-b-1", sourceRegionId: "a", targetRegionId: "b", schema: "application/json", payloadBytes: 2048 },
    { sampleId: "a-c-1", sourceRegionId: "a", targetRegionId: "c", schema: "application/json", payloadBytes: 4096 },
    { sampleId: "b-c-1", sourceRegionId: "b", targetRegionId: "c", schema: "application/json", payloadBytes: 1536 },
    { sampleId: "local-c-1", sourceRegionId: "c", targetRegionId: "c", schema: "application/json", payloadBytes: 768 },
  ];
  const provenance = {
    datasetId: "g226-runtime-route-workload-v1",
    source: "packages/runtime/test/region-migration.test.mjs::bounded-matched-workload",
    capturedAt: new Date().toISOString(),
    repetitions: 5000,
    costModel: {
      fixedCostUnits: 1,
      perInterRegionHopCostUnits: 0.25,
      perTransferredByteCostUnits: 0.00001,
    },
  };
  const result = benchmarkMatchedRegionVsFlat(
    topology,
    workload,
    provenance,
    () => performance.now(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.provenance.datasetId, provenance.datasetId);
  assert.equal(result.value.region.count, workload.length);
  assert.equal(result.value.flat.count, workload.length);
  assert.equal(result.value.telemetry.length, workload.length * 2);
  assert.ok(result.value.region.p95LatencyMs >= 0);
  assert.ok(result.value.flat.p95LatencyMs >= 0);

  for (const sample of workload) {
    const matched = result.value.telemetry.filter(row => row.sampleId === sample.sampleId);
    assert.deepEqual(new Set(matched.map(row => row.mode)), new Set(["region", "flat"]));
    assert.ok(matched.every(row => row.datasetId === provenance.datasetId));
  }

  console.log("G226_OBSERVED_BENCHMARK", JSON.stringify({
    provenance: result.value.provenance,
    region: result.value.region,
    flat: result.value.flat,
  }));
});
