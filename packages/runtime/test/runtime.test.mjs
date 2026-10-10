import test from "node:test";
import assert from "node:assert/strict";
import {
  compileGraph,
  deserializeRunReceipt,
  runExecutableGraph,
  serializeRunReceipt,
} from "../dist/index.js";

const NOW = "2026-09-27T09:50:00+02:00";

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

function node(id, kind, q, permission = null) {
  const faces = Array.from({ length: 6 }, (_, index) =>
    emptyFace(index),
  );

  if (q > 0) {
    faces[3] = {
      ...emptyFace(3),
      semanticChannels: [
        {
          id: `${id}.in`,
          direction: "input",
          transport: "message",
          schema: "application/json",
          optional: false,
        },
      ],
      acceptedSchemas: ["application/json"],
    };
  }

  if (q < 4) {
    faces[0] = {
      ...emptyFace(0),
      semanticChannels: [
        {
          id: `${id}.out`,
          direction: "output",
          transport: "message",
          schema: "application/json",
          optional: false,
        },
      ],
      acceptedSchemas: ["application/json"],
    };
  }

  return {
    id,
    kind,
    level: 0,
    parentId: null,
    coordinate: { q, r: 0 },
    faces,
    neuralCircuitRef: null,
    config:
      permission === null
        ? { label: id }
        : { label: id, permission },
    stateRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function connection(id, source, target) {
  return {
    id,
    source: { nodeId: source.id, faceIndex: 0 },
    target: { nodeId: target.id, faceIndex: 3 },
    semanticBindings: [
      {
        sourceChannelId: `${source.id}.out`,
        targetChannelId: `${target.id}.in`,
        transformRef: null,
      },
    ],
    neuralBridgeRef: null,
    enabled: true,
    createdAt: NOW,
  };
}

function chainGraph({
  maxHops = 8,
  maxRuntimeMs = 100,
  maxExternalCalls = 2,
  maxCostUnits = 10,
  toolPermission = "tool.echo",
} = {}) {
  const input = node("input", "input", 0);
  const transform = node("transform", "compute", 1);
  const tool = node("tool", "tool", 2, toolPermission);
  const evaluator = node("evaluator", "evaluator", 3);
  const output = node("output", "output", 4);

  return {
    protocolVersion: "0.1",
    id: "runtime-chain",
    version: "v1",
    nodes: [input, transform, tool, evaluator, output],
    connections: [
      connection("c1", input, transform),
      connection("c2", transform, tool),
      connection("c3", tool, evaluator),
      connection("c4", evaluator, output),
    ],
    clusters: [],
    neuralCircuits: [],
    resourceBudget: {
      maxHops,
      maxRuntimeMs,
      maxExternalCalls,
      maxCostUnits,
    },
  };
}

function policy() {
  return { allowedPermissions: ["tool.echo"] };
}

function adapters({
  toolCost = 2,
  toolCalls = 1,
  toolDuration = 5,
} = {}) {
  return {
    byNodeId: {
      transform: {
        id: "stub.transform",
        execute: ({ signal }) => ({
          payloadRef: `${signal.payloadRef}:transformed`,
          durationMs: 1,
        }),
      },
      tool: {
        id: "stub.tool",
        execute: ({ signal }) => ({
          payloadRef: `${signal.payloadRef}:tool`,
          externalCalls: toolCalls,
          costUnits: toolCost,
          durationMs: toolDuration,
          artifact: {
            id: "artifact-tool",
            mimeType: "application/json",
            storageRef: "artifact://tool-output",
            metadata: { source: "stub.tool" },
          },
        }),
      },
      evaluator: {
        id: "stub.evaluator",
        execute: ({ signal }) => ({
          payloadRef: `${signal.payloadRef}:accepted`,
          durationMs: 1,
        }),
      },
    },
  };
}

function runOptions(runId = "run-1") {
  return {
    runId,
    startedAt: NOW,
    completedAt: NOW,
    initialPayloadRef: "artifact://input",
    initialSchema: "application/json",
    traceId: "trace-fixed",
    adapters: adapters(),
  };
}

test("compiler rejects schema, permission and budget errors before execution", () => {
  const permissionGraph = chainGraph({ toolPermission: "tool.forbidden" });
  const denied = compileGraph(permissionGraph, 42, policy());
  assert.equal(denied.ok, false);
  assert.ok(
    denied.errors.some((error) => error.code === "PERMISSION_DENIED"),
  );

  const unbounded = chainGraph({ maxCostUnits: null });
  const noCostBound = compileGraph(unbounded, 42, policy());
  assert.equal(noCostBound.ok, false);
  assert.ok(
    noCostBound.errors.some((error) => error.code === "UNBOUNDED_COST"),
  );

  const schemaGraph = chainGraph();
  schemaGraph.nodes[1].faces[3].semanticChannels[0].schema = "text/plain";
  const badSchema = compileGraph(schemaGraph, 42, policy());
  assert.equal(badSchema.ok, false);
  assert.ok(
    badSchema.errors.some(
      (error) =>
        error.code === "GRAPH_INVALID" &&
        error.message.includes("INCOMPATIBLE_CHANNEL_SCHEMA"),
    ),
  );
});

test("input -> transform -> tool -> evaluator -> output completes without SNN", () => {
  const compiled = compileGraph(chainGraph(), 1234, policy());
  assert.equal(compiled.ok, true);

  const receipt = runExecutableGraph(
    compiled.executable,
    runOptions("closed-loop"),
  );

  assert.equal(receipt.status, "completed");
  assert.equal(receipt.termination.code, "COMPLETED");
  assert.deepEqual(
    receipt.trace.map((event) => event.nodeId),
    ["input", "transform", "tool", "evaluator", "output"],
  );
  assert.equal(receipt.outputs.length, 1);
  assert.equal(
    receipt.outputs[0].payloadRef,
    "artifact://input:transformed:tool:accepted",
  );
  assert.equal(receipt.artifacts.length, 1);
  assert.deepEqual(receipt.artifacts[0].provenance, {
    graphId: "runtime-chain",
    graphVersion: "v1",
    seed: 1234,
    adapterId: "stub.tool",
  });
  assert.equal(receipt.checkpoints.length, 5);
  assert.equal(receipt.totals.externalCalls, 1);
  assert.equal(receipt.totals.costUnits, 2);
});


test("external adapter provider billing reference reaches the run trace without converting cost units", () => {
  const compiled = compileGraph(chainGraph(), 42, policy());
  assert.equal(compiled.ok, true);
  const fixture = adapters();
  fixture.byNodeId.tool.execute = () => ({
    externalCalls: 1,
    costUnits: 2,
    durationMs: 1,
    providerMeter: {
      amountUsd: 0.017,
      receiptId: "provider-bill-17",
      source: "provider-usage-endpoint",
    },
  });
  const receipt = runExecutableGraph(compiled.executable, {
    ...runOptions("actual-usd-meter-channel"),
    adapters: fixture,
  });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.totals.costUnits, 2);
  assert.deepEqual(receipt.trace.find((e) => e.nodeId === "tool").providerMeter, {
    amountUsd: 0.017,
    receiptId: "provider-bill-17",
    source: "provider-usage-endpoint",
  });
});

test("runtime rejects fake or unbound provider money measurements", () => {
  const compiled = compileGraph(chainGraph(), 42, policy());
  assert.equal(compiled.ok, true);
  const invalidMeters = [
    { amountUsd: -1, receiptId: "r", source: "provider" },
    { amountUsd: NaN, receiptId: "r", source: "provider" },
    { amountUsd: 1, receiptId: "", source: "provider" },
    { amountUsd: 1, receiptId: "r", source: "" },
  ];
  for (const providerMeter of invalidMeters) {
    const fixture = adapters();
    fixture.byNodeId.tool.execute = () => ({
      externalCalls: 1,
      costUnits: 2,
      providerMeter,
    });
    const receipt = runExecutableGraph(compiled.executable, {
      ...runOptions("invalid-money-meter"),
      adapters: fixture,
    });
    assert.equal(receipt.termination.code, "ADAPTER_FAILED");
    assert.equal(receipt.trace.find((e) => e.nodeId === "tool"), undefined);
  }
});

test("same graph version, seed and fixtures produce byte-identical replay receipts", () => {
  const compiledA = compileGraph(chainGraph(), 777, policy());
  const compiledB = compileGraph(chainGraph(), 777, policy());
  assert.equal(compiledA.ok, true);
  assert.equal(compiledB.ok, true);

  const receiptA = runExecutableGraph(
    compiledA.executable,
    runOptions("replay"),
  );
  const receiptB = runExecutableGraph(
    compiledB.executable,
    runOptions("replay"),
  );

  assert.equal(
    serializeRunReceipt(receiptA),
    serializeRunReceipt(receiptB),
  );
});

test("run receipt/checkpoints/artifact provenance survive serialization round-trip", () => {
  const compiled = compileGraph(chainGraph(), 11, policy());
  assert.equal(compiled.ok, true);

  const receipt = runExecutableGraph(
    compiled.executable,
    runOptions("serialize"),
  );
  const restored = deserializeRunReceipt(
    serializeRunReceipt(receipt),
  );

  assert.deepEqual(restored, receipt);
  assert.equal(restored.checkpoints[2].graphVersion, "v1");
  assert.equal(restored.artifacts[0].traceId, "trace-fixed");
});

test("external-call, cost and runtime budgets terminate explicitly", () => {
  const graph = chainGraph({
    maxRuntimeMs: 4,
    maxExternalCalls: 1,
    maxCostUnits: 1,
  });
  const compiled = compileGraph(graph, 5, policy());
  assert.equal(compiled.ok, true);

  const costReceipt = runExecutableGraph(compiled.executable, {
    ...runOptions("cost"),
    adapters: adapters({ toolCost: 2, toolCalls: 1, toolDuration: 1 }),
  });
  assert.equal(costReceipt.termination.code, "MAX_COST_EXCEEDED");

  const callGraph = chainGraph({
    maxRuntimeMs: 100,
    maxExternalCalls: 1,
    maxCostUnits: 10,
  });
  const callCompiled = compileGraph(callGraph, 5, policy());
  assert.equal(callCompiled.ok, true);
  const callReceipt = runExecutableGraph(callCompiled.executable, {
    ...runOptions("calls"),
    adapters: adapters({ toolCost: 0, toolCalls: 2, toolDuration: 1 }),
  });
  assert.equal(
    callReceipt.termination.code,
    "MAX_EXTERNAL_CALLS_EXCEEDED",
  );

  const runtimeGraph = chainGraph({
    maxRuntimeMs: 2,
    maxExternalCalls: 2,
    maxCostUnits: 10,
  });
  const runtimeCompiled = compileGraph(runtimeGraph, 5, policy());
  assert.equal(runtimeCompiled.ok, true);
  const runtimeReceipt = runExecutableGraph(
    runtimeCompiled.executable,
    {
      ...runOptions("runtime"),
      adapters: adapters({
        toolCost: 0,
        toolCalls: 1,
        toolDuration: 5,
      }),
    },
  );
  assert.equal(
    runtimeReceipt.termination.code,
    "MAX_RUNTIME_EXCEEDED",
  );
});

test("cyclic graph is bounded by maxHops", () => {
  const a = node("a", "input", 0);
  const b = node("b", "compute", 1);
  const output = node("output", "output", 4);

  // Give b an output channel on face 3 and a matching input on face 0
  // so the reverse edge remains geometrically adjacent.
  b.faces[3].semanticChannels.push({
    id: "b.back",
    direction: "output",
    transport: "message",
    schema: "application/json",
    optional: false,
  });
  b.faces[3].acceptedSchemas = ["application/json"];
  a.faces[0].semanticChannels.push({
    id: "a.back",
    direction: "input",
    transport: "message",
    schema: "application/json",
    optional: false,
  });
  a.faces[0].acceptedSchemas = ["application/json"];

  const forward = connection("forward", a, b);
  const backward = {
    id: "backward",
    source: { nodeId: "b", faceIndex: 3 },
    target: { nodeId: "a", faceIndex: 0 },
    semanticBindings: [
      {
        sourceChannelId: "b.back",
        targetChannelId: "a.back",
        transformRef: null,
      },
    ],
    neuralBridgeRef: null,
    enabled: true,
    createdAt: NOW,
  };

  const graph = {
    protocolVersion: "0.1",
    id: "cycle",
    version: "v1",
    nodes: [a, b, output],
    connections: [forward, backward],
    clusters: [],
    neuralCircuits: [],
    resourceBudget: {
      maxHops: 3,
      maxRuntimeMs: 100,
      maxExternalCalls: 0,
      maxCostUnits: null,
    },
  };

  const compiled = compileGraph(graph, 9, {
    allowedPermissions: [],
  });
  assert.equal(compiled.ok, true);

  const receipt = runExecutableGraph(compiled.executable, {
    runId: "cycle-run",
    startedAt: NOW,
    completedAt: NOW,
    initialPayloadRef: "artifact://cycle",
    initialSchema: "application/json",
  });

  assert.equal(receipt.status, "terminated");
  assert.equal(receipt.termination.code, "MAX_HOPS_EXCEEDED");
  assert.ok(receipt.trace.length <= 4);
});

test("missing external adapter fails closed", () => {
  const compiled = compileGraph(chainGraph(), 42, policy());
  assert.equal(compiled.ok, true);

  const receipt = runExecutableGraph(compiled.executable, {
    ...runOptions("missing-adapter"),
    adapters: {
      byNodeId: {
        transform: adapters().byNodeId.transform,
        evaluator: adapters().byNodeId.evaluator,
      },
    },
  });

  assert.equal(receipt.termination.code, "ADAPTER_MISSING");
});

test("reject non-finite and negative adapter budget metrics", () => {
  const compiled = compileGraph(chainGraph(), 515, policy());
  assert.equal(compiled.ok, true);
  for (const key of ["durationMs", "externalCalls", "costUnits"]) {
    for (const value of [NaN, Infinity, -Infinity, -1]) {
      const mock = adapters({ toolCost: 0, toolCalls: 0, toolDuration: 0 });
      mock.byNodeId.tool.execute = () => ({ [key]: value });
      const receipt = runExecutableGraph(compiled.executable, {
        ...runOptions("invalid-metric"),
        adapters: mock,
      });
      assert.equal(receipt.termination.code, "ADAPTER_FAILED");
      assert.equal(receipt.trace.length, 2);
      assert.ok(Object.values(receipt.totals).every(Number.isFinite));
      assert.deepEqual(deserializeRunReceipt(serializeRunReceipt(receipt)), receipt);
    }
  }
});
