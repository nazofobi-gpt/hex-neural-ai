import test from "node:test";
import assert from "node:assert/strict";
import {
  FencedLease,
  RecoveryRuntime,
  createCheckpoint,
  measureRecovery,
  warmHandoff,
} from "../dist/index.js";

const base = createCheckpoint({
  id: "cp-micro-10",
  tier: "micro",
  generation: 1,
  journalOffset: 10,
  createdAtMs: 1000,
  state: { cognition: "stable", counter: 10 },
});

test("planned warm handoff replays tail before atomic fenced lease transfer", () => {
  const lease = new FencedLease();
  const oldToken = lease.transfer("gen-1");
  lease.assert("gen-1", oldToken);

  const handoff = warmHandoff({
    oldGeneration: "gen-1",
    newGeneration: "gen-2",
    lease,
    checkpoint: base,
    tail: [
      { offset: 11, idempotencyKey: "evt-11", payload: { counter: 11 } },
      { offset: 12, idempotencyKey: "evt-12", payload: { cognition: "ready" } },
    ],
  });

  assert.equal(handoff.replayed, 2);
  assert.deepEqual(handoff.runtime.snapshot(), { state: { cognition: "ready", counter: 11 }, offset: 12 });
  lease.assert("gen-2", handoff.newToken);
  assert.throws(() => lease.assert("gen-1", oldToken), /STALE_GENERATION_FENCED/);
});

test("crash replay is duplicate-safe and reports measured RPO/RTO/pause", () => {
  const runtime = new RecoveryRuntime();
  runtime.restore(base);
  assert.deepEqual(runtime.replay([
    { offset: 11, idempotencyKey: "evt-11", payload: { counter: 11 } },
    { offset: 12, idempotencyKey: "evt-12", payload: { counter: 12 } },
  ]), { applied: 2, duplicates: 0 });
  assert.deepEqual(runtime.replay([
    { offset: 11, idempotencyKey: "evt-11", payload: { counter: 999 } },
    { offset: 12, idempotencyKey: "evt-12", payload: { counter: 999 } },
  ]), { applied: 0, duplicates: 2 });
  assert.deepEqual(measureRecovery({
    checkpointOffset: 10,
    durableTailOffset: 12,
    recoveredOffset: 12,
    failureAtMs: 2000,
    readyAtMs: 2125,
    trafficPauseStartMs: 2010,
    trafficResumeMs: 2100,
  }), { rpoEvents: 0, rtoMs: 125, pauseMs: 90 });
});

test("corrupt checkpoint and journal gaps fail closed", () => {
  const corrupt = structuredClone(base);
  corrupt.state.counter = 999;
  const runtime = new RecoveryRuntime();
  assert.throws(() => runtime.restore(corrupt), /CHECKPOINT_CORRUPT/);

  runtime.restore(base);
  assert.throws(() => runtime.replay([
    { offset: 12, idempotencyKey: "evt-12", payload: { counter: 12 } },
  ]), /JOURNAL_GAP/);
});

test("checkpoint hierarchy accepts micro neural and full snapshots", () => {
  for (const tier of ["micro", "neural", "full"]) {
    const checkpoint = createCheckpoint({
      id: `cp-${tier}`,
      tier,
      generation: 2,
      journalOffset: 20,
      createdAtMs: 3000,
      state: { tier },
    });
    const runtime = new RecoveryRuntime();
    runtime.restore(checkpoint);
    assert.equal(runtime.snapshot().state.tier, tier);
  }
});
