import test from "node:test";
import assert from "node:assert/strict";
import {
  CapabilityRegistry,
  DISTRIBUTED_PROTOCOL_VERSION,
  InMemorySingleNodeAdapter,
} from "../dist/index.js";

function fixture({ generation = 2, maxInFlight = 1, maxQueueDepth = 0 } = {}) {
  const registry = new CapabilityRegistry();
  const replica = {
    logicalId: "hex/worker-a",
    replicaId: "local-1",
    generation,
    providerId: "memory",
  };
  registry.register({
    capability: {
      id: "sum",
      version: "1",
      inputSchemas: ["application/json"],
      outputSchemas: ["application/json"],
      maxInFlight: 1,
    },
    replica,
    state: "ready",
  });
  const adapter = new InMemorySingleNodeAdapter({
    cluster: {
      clusterId: "cluster-1",
      namespace: "hex",
      protocolVersion: DISTRIBUTED_PROTOCOL_VERSION,
    },
    replica,
    registry,
    backpressure: { maxInFlight, maxQueueDepth },
    fence: {
      namespace: "hex",
      ownerLogicalId: replica.logicalId,
      generation,
      token: "fixture-token",
    },
  });
  return { adapter, replica };
}

function envelope(replica, overrides = {}) {
  return {
    protocolVersion: DISTRIBUTED_PROTOCOL_VERSION,
    messageId: "m-1",
    idempotencyKey: "idem-1",
    namespace: "hex",
    sourceLogicalId: "hex/source",
    targetLogicalId: replica.logicalId,
    capabilityId: "sum",
    capabilityVersion: "1",
    generation: replica.generation,
    delivery: "idempotent",
    payload: { a: 2, b: 3 },
    ...overrides,
  };
}

test("single-node adapter preserves typed domain dispatch parity", () => {
  const { adapter, replica } = fixture();
  const result = adapter.dispatch(envelope(replica), ({ a, b }) => a + b);
  assert.deepEqual(result, { ok: true, value: 5, duplicate: false });
});

test("idempotent delivery executes handler exactly once", () => {
  const { adapter, replica } = fixture();
  let calls = 0;
  const message = envelope(replica);
  const first = adapter.dispatch(message, () => ++calls);
  const second = adapter.dispatch({ ...message, messageId: "m-2" }, () => ++calls);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.value, 1);
  assert.equal(calls, 1);
});

test("stale generation and invalid fence fail closed", () => {
  const { adapter, replica } = fixture();
  const stale = adapter.dispatch(
    envelope(replica, { generation: replica.generation - 1 }),
    () => 1,
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "STALE_GENERATION");

  adapter.setFence({
    namespace: "hex",
    ownerLogicalId: replica.logicalId,
    generation: replica.generation + 1,
    token: "new-owner",
  });
  const fenced = adapter.dispatch(
    envelope(replica, { messageId: "m-fenced", idempotencyKey: "idem-fenced" }),
    () => 1,
  );
  assert.equal(fenced.ok, false);
  assert.equal(fenced.error.code, "FENCE_REJECTED");
});

test("bounded backpressure rejects nested over-capacity dispatch deterministically", () => {
  const { adapter, replica } = fixture({ maxInFlight: 1, maxQueueDepth: 0 });
  const outer = adapter.dispatch(envelope(replica), () => {
    const nested = adapter.dispatch(
      envelope(replica, {
        messageId: "m-nested",
        idempotencyKey: "idem-nested",
      }),
      () => 99,
    );
    assert.equal(nested.ok, false);
    assert.equal(nested.error.code, "BACKPRESSURE");
    return 5;
  });
  assert.equal(outer.ok, true);
  assert.equal(outer.value, 5);
});
