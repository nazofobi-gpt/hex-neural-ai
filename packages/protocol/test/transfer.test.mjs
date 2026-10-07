import test from "node:test";
import assert from "node:assert/strict";
import {
  OPPOSITE_FACE,
  connectFaces,
  disconnectFaceConnection,
  neighbor,
  relaySemantic,
  transferSemantic,
} from "../dist/index.js";

const CREATED_AT = "2026-09-27T09:30:00+02:00";

function face(index, {
  direction = "bidirectional",
  schema = "application/json",
  channelId = `ch-${index}`,
  transport = "message",
  inputPolicy = "allow",
  outputPolicy = "allow",
  projectionPopulation = [],
} = {}) {
  return {
    index,
    semanticChannels: [
      {
        id: channelId,
        direction,
        transport,
        schema,
        optional: false,
      },
    ],
    projectionPopulation,
    inputPolicy,
    outputPolicy,
    acceptedSchemas: [schema],
    connectionIds: [],
  };
}

function emptyFace(index) {
  return {
    index,
    semanticChannels: [],
    projectionPopulation: [],
    inputPolicy: "allow",
    outputPolicy: "allow",
    acceptedSchemas: [],
    connectionIds: [],
  };
}

function cell(id, coordinate, activeFace, {
  direction,
  schema = "application/json",
  channelId,
  kind = "compute",
  projectionPopulation = [],
} = {}) {
  const faces = Array.from({ length: 6 }, (_, index) => emptyFace(index));
  faces[activeFace] = face(activeFace, {
    direction,
    schema,
    channelId: channelId ?? `${id}.face-${activeFace}`,
    projectionPopulation,
  });

  return {
    id,
    kind,
    level: 0,
    parentId: null,
    coordinate,
    faces,
    neuralCircuitRef: null,
    config: {},
    stateRef: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function mustConnect(source, target, sourceFaceIndex, targetFaceIndex, id) {
  const result = connectFaces(source, target, {
    id,
    sourceFaceIndex,
    targetFaceIndex,
    createdAt: CREATED_AT,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  return result.value;
}

test("all six face directions negotiate a typed semantic connection", () => {
  const origin = { q: 0, r: 0 };

  for (let sourceFaceIndex = 0; sourceFaceIndex < 6; sourceFaceIndex += 1) {
    const targetFaceIndex = OPPOSITE_FACE[sourceFaceIndex];
    const source = cell("source", origin, sourceFaceIndex, {
      direction: "output",
      schema: "text/plain",
      channelId: `out-${sourceFaceIndex}`,
    });
    const target = cell(
      "target",
      neighbor(origin, sourceFaceIndex),
      targetFaceIndex,
      {
        direction: "input",
        schema: "text/plain",
        channelId: `in-${targetFaceIndex}`,
      },
    );

    const result = connectFaces(source, target, {
      id: `connection-${sourceFaceIndex}`,
      sourceFaceIndex,
      targetFaceIndex,
      createdAt: CREATED_AT,
    });

    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    assert.equal(result.value.schema, "text/plain");
    assert.equal(result.value.source.faceIndex, sourceFaceIndex);
    assert.equal(result.value.target.faceIndex, targetFaceIndex);
  }
});

test("schema mismatch and non-adjacent faces reject deterministically", () => {
  const source = cell("source", { q: 0, r: 0 }, 0, {
    direction: "output",
    schema: "text/plain",
  });
  const mismatched = cell("target", { q: 1, r: 0 }, 3, {
    direction: "input",
    schema: "application/json",
  });

  const mismatch = connectFaces(source, mismatched, {
    id: "mismatch",
    sourceFaceIndex: 0,
    targetFaceIndex: 3,
    createdAt: CREATED_AT,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "SCHEMA_MISMATCH");

  const farTarget = cell("far", { q: 2, r: 0 }, 3, {
    direction: "input",
    schema: "text/plain",
  });
  const far = connectFaces(source, farTarget, {
    id: "far",
    sourceFaceIndex: 0,
    targetFaceIndex: 3,
    createdAt: CREATED_AT,
  });
  assert.equal(far.ok, false);
  assert.equal(far.error.code, "NON_ADJACENT");
});

test("semantic payload and neural control remain separate across a transfer", () => {
  const source = cell("source", { q: 0, r: 0 }, 0, {
    direction: "output",
    schema: "application/json",
    channelId: "out.json",
    projectionPopulation: ["src-n1", "src-n2"],
  });
  const target = cell("target", { q: 1, r: 0 }, 3, {
    direction: "input",
    schema: "application/json",
    channelId: "in.json",
    projectionPopulation: ["dst-n1"],
  });
  const connection = mustConnect(source, target, 0, 3, "c1");

  const envelope = {
    id: "signal-1",
    traceId: "trace-1",
    payloadRef: "artifact://payload-1",
    schema: "application/json",
    channelId: "out.json",
    origin: { nodeId: "source", faceIndex: 0 },
    current: { nodeId: "source", faceIndex: 0 },
    hopCount: 0,
    ttl: 8,
    createdAt: CREATED_AT,
  };

  const neuralControl = {
    traceId: "wrong-trace-will-be-normalized",
    gate: 0.75,
    activation: 0.4,
    sourceProjectionPopulation: [],
    targetProjectionPopulation: [],
  };

  const result = transferSemantic(
    connection,
    envelope,
    source.faces[0],
    target.faces[3],
    neuralControl,
  );

  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  assert.equal(result.value.semantic.payloadRef, "artifact://payload-1");
  assert.equal(result.value.semantic.traceId, "trace-1");
  assert.deepEqual(result.value.semantic.origin, {
    nodeId: "source",
    faceIndex: 0,
  });
  assert.deepEqual(result.value.semantic.current, {
    nodeId: "target",
    faceIndex: 3,
  });
  assert.equal(result.value.semantic.hopCount, 1);
  assert.equal(result.value.semantic.ttl, 7);
  assert.equal(result.value.semantic.channelId, "in.json");

  assert.deepEqual(result.value.neuralControl, {
    traceId: "trace-1",
    gate: 0.75,
    activation: 0.4,
    sourceProjectionPopulation: ["src-n1", "src-n2"],
    targetProjectionPopulation: ["dst-n1"],
  });

  assert.equal("payloadRef" in result.value.neuralControl, false);
  assert.equal("permissions" in result.value.neuralControl, false);
});

test("disconnect prevents subsequent transfer", () => {
  const source = cell("source", { q: 0, r: 0 }, 0, {
    direction: "output",
    channelId: "out",
  });
  const target = cell("target", { q: 1, r: 0 }, 3, {
    direction: "input",
    channelId: "in",
  });

  const connection = disconnectFaceConnection(
    mustConnect(source, target, 0, 3, "c1"),
  );

  const result = transferSemantic(
    connection,
    {
      id: "signal",
      traceId: "trace",
      payloadRef: "artifact://1",
      schema: "application/json",
      channelId: "out",
      origin: { nodeId: "source", faceIndex: 0 },
      current: { nodeId: "source", faceIndex: 0 },
      hopCount: 0,
      ttl: 4,
      createdAt: CREATED_AT,
    },
    source.faces[0],
    target.faces[3],
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DISCONNECTED");
});

test("relay path reaches a distant node only through adjacent face hops", () => {
  const source = cell("source", { q: 0, r: 0 }, 0, {
    direction: "output",
    channelId: "source.out",
  });

  const relayIn = cell("relay", { q: 1, r: 0 }, 3, {
    direction: "input",
    channelId: "relay.in",
    kind: "axon",
  });
  relayIn.faces[0] = face(0, {
    direction: "output",
    channelId: "relay.out",
  });

  const target = cell("target", { q: 2, r: 0 }, 3, {
    direction: "input",
    channelId: "target.in",
  });

  const first = mustConnect(source, relayIn, 0, 3, "source-relay");
  const second = mustConnect(relayIn, target, 0, 3, "relay-target");

  const direct = connectFaces(source, target, {
    id: "illegal-direct",
    sourceFaceIndex: 0,
    targetFaceIndex: 3,
    createdAt: CREATED_AT,
  });
  assert.equal(direct.ok, false);
  assert.equal(direct.error.code, "NON_ADJACENT");

  const relayed = relaySemantic(
    {
      id: "signal",
      traceId: "trace-relay",
      payloadRef: "artifact://relay",
      schema: "application/json",
      channelId: "source.out",
      origin: { nodeId: "source", faceIndex: 0 },
      current: { nodeId: "source", faceIndex: 0 },
      hopCount: 0,
      ttl: 6,
      createdAt: CREATED_AT,
    },
    [
      {
        connection: first,
        sourceFace: source.faces[0],
        targetFace: relayIn.faces[3],
      },
      {
        connection: second,
        sourceFace: relayIn.faces[0],
        targetFace: target.faces[3],
      },
    ],
  );

  assert.equal(relayed.ok, true, relayed.ok ? "" : relayed.error.message);
  assert.equal(relayed.value.length, 2);
  assert.equal(relayed.value[1].semantic.current.nodeId, "target");
  assert.equal(relayed.value[1].semantic.hopCount, 2);
  assert.equal(relayed.value[1].semantic.ttl, 4);
  assert.equal(relayed.value[1].semantic.traceId, "trace-relay");
  assert.equal(relayed.value[1].semantic.payloadRef, "artifact://relay");
});

test("relay route break is explicit", () => {
  const a = cell("a", { q: 0, r: 0 }, 0, {
    direction: "output",
    channelId: "a.out",
  });
  const b = cell("b", { q: 1, r: 0 }, 3, {
    direction: "input",
    channelId: "b.in",
  });
  const unrelated = cell("x", { q: 10, r: 0 }, 0, {
    direction: "output",
    channelId: "x.out",
  });
  const y = cell("y", { q: 11, r: 0 }, 3, {
    direction: "input",
    channelId: "y.in",
  });

  const first = mustConnect(a, b, 0, 3, "ab");
  const second = mustConnect(unrelated, y, 0, 3, "xy");

  const result = relaySemantic(
    {
      id: "signal",
      traceId: "trace",
      payloadRef: "artifact://route",
      schema: "application/json",
      channelId: "a.out",
      origin: { nodeId: "a", faceIndex: 0 },
      current: { nodeId: "a", faceIndex: 0 },
      hopCount: 0,
      ttl: 5,
      createdAt: CREATED_AT,
    },
    [
      {
        connection: first,
        sourceFace: a.faces[0],
        targetFace: b.faces[3],
      },
      {
        connection: second,
        sourceFace: unrelated.faces[0],
        targetFace: y.faces[3],
      },
    ],
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ROUTE_BREAK");
});
