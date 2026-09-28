import test from "node:test";
import assert from "node:assert/strict";
import {
  ActionCoordinator,
  EdgeGatewayMock,
  RegionCapabilityFabric,
  computeAudioOverlapMs,
} from "../dist/index.js";

const workers = ["hex/worker-a", "hex/worker-b", "hex/worker-c"];
const regions = [
  { id: "vision", version: "1", memberLogicalIds: ["hex/worker-a"] },
  { id: "audio", version: "1", memberLogicalIds: ["hex/worker-b"] },
  { id: "interaction", version: "1", memberLogicalIds: ["hex/worker-c"] },
];
const projections = [
  { regionId: "vision", faceIndex: 0, capabilityIds: ["edge.screen"] },
  { regionId: "audio", faceIndex: 1, capabilityIds: ["edge.microphone", "edge.speaker"] },
  { regionId: "interaction", faceIndex: 2, capabilityIds: ["edge.touch"] },
];
const scopes = [
  { capabilityId: "edge.screen", kind: "screen", regionId: "vision", workerLogicalId: "hex/worker-a", privacy: { requiresIndicator: true, indicator: "visual" } },
  { capabilityId: "edge.microphone", kind: "microphone", regionId: "audio", workerLogicalId: "hex/worker-b", privacy: { requiresIndicator: true, indicator: "visual_and_audible" } },
  { capabilityId: "edge.speaker", kind: "speaker", regionId: "audio", workerLogicalId: "hex/worker-b", privacy: { requiresIndicator: false, indicator: "audible" } },
  { capabilityId: "edge.touch", kind: "touch", regionId: "interaction", workerLogicalId: "hex/worker-c", privacy: { requiresIndicator: true, indicator: "visual" } },
];

test("three-worker fabric preserves region locality and association projections", () => {
  const fabric = new RegionCapabilityFabric({ workers, regions, projections, scopes });
  assert.equal(fabric.resolve("edge.screen")?.workerLogicalId, "hex/worker-a");
  assert.equal(fabric.resolve("edge.microphone")?.workerLogicalId, "hex/worker-b");
  assert.equal(fabric.resolve("edge.touch")?.workerLogicalId, "hex/worker-c");
  assert.equal(fabric.projectionFor("edge.speaker")?.faceIndex, 1);
  assert.throws(() => fabric.assertPrivacyIndicator("edge.screen", false), /PRIVACY_INDICATOR_REQUIRED/);
  fabric.assertPrivacyIndicator("edge.screen", true);
});

test("edge gateway keeps bounded ordered screen/audio buffers across reconnect", () => {
  const gateway = new EdgeGatewayMock(2);
  gateway.ingest({ kind: "screen", streamId: "screen-1", sequence: 1, timestampMs: 10, mode: "full", frameRef: "f1" });
  gateway.ingest({ kind: "screen", streamId: "screen-1", sequence: 2, timestampMs: 20, mode: "delta", frameRef: "f2", roi: { x: 10, y: 10, width: 100, height: 80 } });
  gateway.ingest({ kind: "screen", streamId: "screen-1", sequence: 3, timestampMs: 30, mode: "delta", frameRef: "f3", roi: { x: 20, y: 20, width: 60, height: 40 } });
  assert.deepEqual(gateway.read("screen-1").map((packet) => packet.sequence), [2, 3]);
  assert.throws(() => gateway.ingest({ kind: "screen", streamId: "screen-1", sequence: 3, timestampMs: 31, mode: "delta", frameRef: "dup" }), /EDGE_SEQUENCE_OUT_OF_ORDER/);

  const a1 = { kind: "audio", streamId: "mic-1", sequence: 1, timestampMs: 100, chunkRef: "a1", startMs: 0, endMs: 100, overlapMs: 0 };
  const a2 = { kind: "audio", streamId: "mic-1", sequence: 2, timestampMs: 180, chunkRef: "a2", startMs: 80, endMs: 180, overlapMs: 20 };
  gateway.ingest(a1);
  gateway.ingest(a2);
  assert.equal(computeAudioOverlapMs(a1, a2), 20);

  gateway.disconnect();
  assert.equal(gateway.isConnected(), false);
  assert.throws(() => gateway.ingest({ kind: "screen", streamId: "screen-1", sequence: 4, timestampMs: 40, mode: "full", frameRef: "f4" }), /EDGE_DISCONNECTED/);
  gateway.reconnect();
  gateway.ingest({ kind: "screen", streamId: "screen-1", sequence: 4, timestampMs: 40, mode: "full", frameRef: "f4" });
  assert.deepEqual(gateway.read("screen-1").map((packet) => packet.sequence), [3, 4]);
});

test("touch is at-most-once and speaker ordering/interruption is authoritative", () => {
  const coordinator = new ActionCoordinator();
  let touchEffects = 0;
  const firstTouch = coordinator.touch("touch-1", () => ++touchEffects);
  const duplicateTouch = coordinator.touch("touch-1", () => ++touchEffects);
  assert.equal(firstTouch.duplicate, false);
  assert.equal(duplicateTouch.duplicate, true);
  assert.equal(touchEffects, 1);

  const first = coordinator.play({ actionId: "play-1", sequence: 1, audioRef: "clip-a", interrupt: false });
  assert.equal(first.receipt.state, "playing");
  assert.throws(() => coordinator.play({ actionId: "play-2", sequence: 2, audioRef: "clip-b", interrupt: false }), /SPEAKER_BUSY/);

  const second = coordinator.play({ actionId: "play-2", sequence: 2, audioRef: "clip-b", interrupt: true });
  assert.equal(second.receipt.state, "playing");
  assert.deepEqual(coordinator.speakerHistory(), [
    { actionId: "play-1", sequence: 1, state: "interrupted", interruptedBy: "play-2" },
    { actionId: "play-2", sequence: 2, state: "playing" },
  ]);

  const duplicatePlay = coordinator.play({ actionId: "play-2", sequence: 2, audioRef: "clip-b", interrupt: true });
  assert.equal(duplicatePlay.duplicate, true);
  assert.equal(coordinator.speakerHistory().length, 2);
});
