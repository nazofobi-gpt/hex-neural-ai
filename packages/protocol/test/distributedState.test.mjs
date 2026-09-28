import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryAtLeastOnceBus, InMemorySharedStateStore } from "../dist/index.js";

test("two workers share checkpoint state with optimistic fencing", () => {
  const db = new InMemorySharedStateStore();
  assert.equal(db.compareAndSet(null, { taskId: "G-206", checkpoint: "cp-1", version: 1, updatedBy: "worker-a" }), true);
  const seen = db.read("G-206");
  assert.equal(seen?.checkpoint, "cp-1");
  assert.equal(db.compareAndSet(0, { taskId: "G-206", checkpoint: "stale", version: 1, updatedBy: "worker-b" }), false);
  assert.equal(db.compareAndSet(1, { taskId: "G-206", checkpoint: "cp-2", version: 2, updatedBy: "worker-b" }), true);
  assert.deepEqual(db.read("G-206"), { taskId: "G-206", checkpoint: "cp-2", version: 2, updatedBy: "worker-b" });
});

test("at-least-once redelivery produces one physical effect and preserves correlation", () => {
  const bus = new InMemoryAtLeastOnceBus();
  bus.publish({ messageId: "m-1", idempotencyKey: "effect-1", consumerGroup: "workers", traceId: "trace-1", checkpoint: "cp-2", payload: { amount: 1 } });
  bus.redeliver("m-1");
  let effects = 0;
  const results = bus.consume("workers", (message) => {
    effects += message.payload.amount;
    return { traceId: message.traceId, checkpoint: message.checkpoint };
  });
  assert.equal(effects, 1);
  assert.equal(results.length, 2);
  assert.equal(results[0].duplicate, false);
  assert.equal(results[1].duplicate, true);
  assert.deepEqual(results[1].value, { traceId: "trace-1", checkpoint: "cp-2" });
});
