import test from "node:test";
import assert from "node:assert/strict";
import {
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
