import assert from "node:assert/strict";
import test from "node:test";
import { ContinualLifecycle } from "../dist/index.js";

const seeded = () => {
  const lifecycle = new ContinualLifecycle();
  lifecycle.registerSource({ id: "source-a", version: "1", digest: "sha256:a" });
  lifecycle.registerSource({ id: "source-b", version: "1", digest: "sha256:b" });
  return lifecycle;
};

test("source removal disables transitive memory, skill and adapter lineage", () => {
  const lifecycle = seeded();
  lifecycle.registerArtifact({ id: "memory-a", kind: "memory", version: "1", sourceIds: ["source-a"] });
  lifecycle.registerArtifact({ id: "skill-a", kind: "skill", version: "1", sourceIds: ["source-b"], parentArtifactIds: ["memory-a"] });
  lifecycle.registerArtifact({ id: "adapter-a", kind: "adapter", version: "1", sourceIds: ["source-b"], parentArtifactIds: ["skill-a"] });
  const result = lifecycle.removeSource("source-a");
  assert.deepEqual(result.disabledArtifactIds, ["adapter-a", "memory-a", "skill-a"]);
  assert.equal(result.remediation.every((item) => item.action === "DELETE_OR_RETRAIN"), true);
});

test("disabled artifacts support explicit delete and retrain workflows", () => {
  const lifecycle = seeded();
  lifecycle.registerArtifact({ id: "old", kind: "memory", version: "1", sourceIds: ["source-a"] });
  lifecycle.removeSource("source-a");
  assert.equal(lifecycle.deleteArtifact("old").status, "DELETED");
  lifecycle.registerArtifact({ id: "old-2", kind: "memory", version: "1", sourceIds: ["source-b"] });
  lifecycle.removeSource("source-b");
  lifecycle.registerSource({ id: "source-c", version: "1", digest: "sha256:c" });
  assert.equal(lifecycle.retrainArtifact("old-2", { id: "new", kind: "memory", version: "2", sourceIds: ["source-c"] }).status, "ACTIVE");
});

test("old-task regression freezes unsafe promotion", () => {
  const lifecycle = seeded();
  const rejected = lifecycle.evaluateOldTaskRegression({ a: .9, b: .8 }, { a: .6, b: .7 }, .1);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.action, "PROMOTION_FROZEN");
  assert.equal(lifecycle.evaluateOldTaskRegression({ a: .9 }, { a: .86 }, .05).accepted, true);
});

test("retention forgets expired and excess bounded episodes", () => {
  const lifecycle = seeded();
  lifecycle.recordEpisode({ id: "old", timestampMs: 0, sourceId: "source-a", summary: "bounded" });
  lifecycle.recordEpisode({ id: "mid", timestampMs: 90, sourceId: "source-a", summary: "bounded" });
  lifecycle.recordEpisode({ id: "new", timestampMs: 100, sourceId: "source-b", summary: "bounded" });
  assert.deepEqual(lifecycle.enforceRetention(100, 20, 1), ["mid", "old"]);
  assert.deepEqual(lifecycle.snapshot().episodes.map((episode) => episode.id), ["new"]);
});

test("checkpoint restart is deterministic and tamper fails closed", () => {
  const lifecycle = seeded();
  lifecycle.registerArtifact({ id: "memory", kind: "memory", version: "1", sourceIds: ["source-a"] });
  const checkpoint = lifecycle.checkpoint();
  const restored = ContinualLifecycle.fromCheckpoint(checkpoint);
  assert.deepEqual(restored.snapshot(), lifecycle.snapshot());
  assert.deepEqual(restored.checkpoint(), checkpoint);
  assert.throws(() => ContinualLifecycle.fromCheckpoint({ ...checkpoint, payload: checkpoint.payload + " " }), /INVALID_CHECKPOINT/);
});

test("registration validates lineage and snapshots are isolated", () => {
  const lifecycle = seeded();
  assert.throws(() => lifecycle.registerArtifact({ id: "bad", kind: "skill", version: "1", sourceIds: ["missing"] }), /UNKNOWN_SOURCE/);
  const artifact = lifecycle.registerArtifact({ id: "good", kind: "skill", version: "1", sourceIds: ["source-a"] });
  artifact.sourceIds.push?.("source-b");
  assert.deepEqual(lifecycle.snapshot().artifacts[0].sourceIds, ["source-a"]);
  assert.equal(lifecycle.residualRisks().length, 3);
});
