import type { HexCell } from "@hex-neural/protocol";
import type {
  ExecutableBinding,
  ExecutableEdge,
  ExecutableGraph,
  RunCheckpoint,
  RunOptions,
  RunReceipt,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeAdapterResult,
  RuntimeArtifactReceipt,
  RuntimeSignal,
  RuntimeTerminationCode,
  RuntimeTotals,
  RuntimeTraceEvent,
} from "./types.js";

const PASSTHROUGH_ADAPTER: RuntimeAdapter = {
  id: "builtin.pass",
  execute: ({ signal }) => ({
    payloadRef: signal.payloadRef,
    schema: signal.schema,
  }),
};

function cloneTotals(totals: RuntimeTotals): RuntimeTotals {
  return { ...totals };
}

function stableHash(seed: number, value: string): number {
  let hash = (2166136261 ^ seed) >>> 0;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return hash >>> 0;
}

function orderedEdges(
  executable: ExecutableGraph,
  nodeId: string,
): ExecutableEdge[] {
  return executable.edges
    .filter((edge) => edge.sourceNodeId === nodeId)
    .sort((a, b) => {
      const rankA = stableHash(executable.seed, a.id);
      const rankB = stableHash(executable.seed, b.id);

      if (rankA !== rankB) {
        return rankA - rankB;
      }

      return a.id.localeCompare(b.id);
    });
}

function resolveAdapter(
  node: HexCell,
  registry: RuntimeAdapterRegistry | undefined,
): RuntimeAdapter | null {
  const byNode = registry?.byNodeId?.[node.id];
  if (byNode) {
    return byNode;
  }

  const byKind = registry?.byKind?.[node.kind];
  if (byKind) {
    return byKind;
  }

  if (node.kind === "model" || node.kind === "tool") {
    return null;
  }

  return PASSTHROUGH_ADAPTER;
}

function chooseBinding(
  edge: ExecutableEdge,
  schema: string | null,
): ExecutableBinding | null {
  if (edge.bindings.length === 0) {
    return schema === null
      ? {
          sourceChannelId: "",
          targetChannelId: "",
          sourceSchema: "",
          targetSchema: "",
          transformRef: null,
        }
      : null;
  }

  if (schema === null) {
    return edge.bindings[0] ?? null;
  }

  return (
    edge.bindings.find((binding) => binding.sourceSchema === schema) ??
    null
  );
}

function normalizedAdapterResult(
  result: RuntimeAdapterResult,
  signal: RuntimeSignal,
): Required<Omit<RuntimeAdapterResult, "artifact">> & {
  artifact: RuntimeAdapterResult["artifact"];
} {
  return {
    payloadRef:
      result.payloadRef === undefined
        ? signal.payloadRef
        : result.payloadRef,
    schema: result.schema === undefined ? signal.schema : result.schema,
    externalCalls: Math.max(0, result.externalCalls ?? 0),
    costUnits: Math.max(0, result.costUnits ?? 0),
    durationMs: Math.max(0, result.durationMs ?? 0),
    artifact: result.artifact ?? null,
  };
}

function termination(
  code: RuntimeTerminationCode,
  message: string,
): RunReceipt["termination"] {
  return { code, message };
}

function checkpoint(
  runId: string,
  sequence: number,
  executable: ExecutableGraph,
  signal: RuntimeSignal,
  totals: RuntimeTotals,
  traceLength: number,
): RunCheckpoint {
  return {
    id: `${runId}:checkpoint:${sequence}`,
    sequence,
    graphId: executable.graphId,
    graphVersion: executable.graphVersion,
    seed: executable.seed,
    signal: { ...signal },
    totals: cloneTotals(totals),
    traceLength,
  };
}

function finalize(
  options: RunOptions,
  executable: ExecutableGraph,
  code: RuntimeTerminationCode,
  message: string,
  trace: RuntimeTraceEvent[],
  checkpoints: RunCheckpoint[],
  artifacts: RuntimeArtifactReceipt[],
  outputs: RuntimeSignal[],
  totals: RuntimeTotals,
): RunReceipt {
  return {
    runId: options.runId,
    graphId: executable.graphId,
    graphVersion: executable.graphVersion,
    seed: executable.seed,
    status: code === "COMPLETED" ? "completed" : "terminated",
    termination: termination(code, message),
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    trace,
    checkpoints,
    artifacts,
    outputs,
    totals,
  };
}

export function runExecutableGraph(
  executable: ExecutableGraph,
  options: RunOptions,
): RunReceipt {
  const nodeById = new Map(
    executable.nodes.map((node) => [node.id, node]),
  );
  const entryNodeId =
    options.entryNodeId ?? executable.entryNodeIds[0] ?? null;

  if (entryNodeId === null || !nodeById.has(entryNodeId)) {
    return finalize(
      options,
      executable,
      "NO_OUTPUT",
      "No valid entry node is available.",
      [],
      [],
      [],
      [],
      {
        processedSignals: 0,
        hops: 0,
        runtimeMs: 0,
        externalCalls: 0,
        costUnits: 0,
      },
    );
  }

  const initialSignal: RuntimeSignal = {
    id: `${options.runId}:signal:0`,
    traceId: options.traceId ?? `${options.runId}:trace`,
    payloadRef: options.initialPayloadRef,
    schema: options.initialSchema,
    originNodeId: entryNodeId,
    currentNodeId: entryNodeId,
    hopCount: 0,
    ttl: executable.budget.maxHops,
  };

  const queue: RuntimeSignal[] = [initialSignal];
  const trace: RuntimeTraceEvent[] = [];
  const checkpoints: RunCheckpoint[] = [];
  const artifacts: RuntimeArtifactReceipt[] = [];
  const outputs: RuntimeSignal[] = [];
  const totals: RuntimeTotals = {
    processedSignals: 0,
    hops: 0,
    runtimeMs: 0,
    externalCalls: 0,
    costUnits: 0,
  };

  let sequence = 0;
  let signalSequence = 1;

  while (queue.length > 0) {
    const signal = queue.shift()!;
    const node = nodeById.get(signal.currentNodeId);

    if (!node) {
      return finalize(
        options,
        executable,
        "NO_OUTPUT",
        `Signal references missing runtime node ${signal.currentNodeId}.`,
        trace,
        checkpoints,
        artifacts,
        outputs,
        totals,
      );
    }

    if (signal.ttl < 0) {
      return finalize(
        options,
        executable,
        "TTL_EXHAUSTED",
        `Signal ${signal.id} exhausted TTL.`,
        trace,
        checkpoints,
        artifacts,
        outputs,
        totals,
      );
    }

    if (signal.hopCount > executable.budget.maxHops) {
      return finalize(
        options,
        executable,
        "MAX_HOPS_EXCEEDED",
        `Signal ${signal.id} exceeded maxHops.`,
        trace,
        checkpoints,
        artifacts,
        outputs,
        totals,
      );
    }

    const adapter = resolveAdapter(node, options.adapters);

    if (adapter === null) {
      return finalize(
        options,
        executable,
        "ADAPTER_MISSING",
        `No runtime adapter registered for external node ${node.id}.`,
        trace,
        checkpoints,
        artifacts,
        outputs,
        totals,
      );
    }

    let rawResult: RuntimeAdapterResult;
    try {
      rawResult = adapter.execute({
        node,
        signal: { ...signal },
        seed: executable.seed,
        sequence,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return finalize(
        options,
        executable,
        "ADAPTER_FAILED",
        `Adapter ${adapter.id} failed at node ${node.id}: ${message}`,
        trace,
        checkpoints,
        artifacts,
        outputs,
        totals,
      );
    }

    const result = normalizedAdapterResult(rawResult, signal);
    totals.processedSignals += 1;
    totals.runtimeMs += result.durationMs;
    totals.externalCalls += result.externalCalls;
    totals.costUnits += result.costUnits;

    const processedSignal: RuntimeSignal = {
      ...signal,
      payloadRef: result.payloadRef,
      schema: result.schema,
    };

    trace.push({
      sequence,
      nodeId: node.id,
      nodeKind: node.kind,
      signalId: signal.id,
      traceId: signal.traceId,
      payloadRef: processedSignal.payloadRef,
      schema: processedSignal.schema,
      hopCount: signal.hopCount,
      ttl: signal.ttl,
      adapterId: adapter.id,
      durationMs: result.durationMs,
      externalCalls: result.externalCalls,
      costUnits: result.costUnits,
    });

    checkpoints.push(
      checkpoint(
        options.runId,
        sequence,
        executable,
        processedSignal,
        totals,
        trace.length,
      ),
    );

    if (result.artifact) {
      artifacts.push({
        id: result.artifact.id,
        mimeType: result.artifact.mimeType,
        storageRef: result.artifact.storageRef,
        sizeBytes: result.artifact.sizeBytes ?? null,
        hash: result.artifact.hash ?? null,
        metadata: result.artifact.metadata ?? {},
        runId: options.runId,
        nodeId: node.id,
        traceId: signal.traceId,
        provenance: {
          graphId: executable.graphId,
          graphVersion: executable.graphVersion,
          seed: executable.seed,
          adapterId: adapter.id,
        },
      });
    }

    if (totals.runtimeMs > executable.budget.maxRuntimeMs) {
      return finalize(
        options,
        executable,
        "MAX_RUNTIME_EXCEEDED",
        "Runtime duration budget exceeded.",
        trace,
        checkpoints,
        artifacts,
        outputs,
        totals,
      );
    }

    if (totals.externalCalls > executable.budget.maxExternalCalls) {
      return finalize(
        options,
        executable,
        "MAX_EXTERNAL_CALLS_EXCEEDED",
        "External-call budget exceeded.",
        trace,
        checkpoints,
        artifacts,
        outputs,
        totals,
      );
    }

    if (
      executable.budget.maxCostUnits !== null &&
      totals.costUnits > executable.budget.maxCostUnits
    ) {
      return finalize(
        options,
        executable,
        "MAX_COST_EXCEEDED",
        "Cost budget exceeded.",
        trace,
        checkpoints,
        artifacts,
        outputs,
        totals,
      );
    }

    if (node.kind === "output") {
      outputs.push(processedSignal);
    }

    for (const edge of orderedEdges(executable, node.id)) {
      const binding = chooseBinding(edge, processedSignal.schema);

      if (binding === null) {
        return finalize(
          options,
          executable,
          "RUNTIME_SCHEMA_MISMATCH",
          `No binding on edge ${edge.id} accepts schema ${processedSignal.schema ?? "null"}.`,
          trace,
          checkpoints,
          artifacts,
          outputs,
          totals,
        );
      }

      const nextHopCount = processedSignal.hopCount + 1;
      const nextTtl = processedSignal.ttl - 1;

      if (nextHopCount > executable.budget.maxHops) {
        return finalize(
          options,
          executable,
          "MAX_HOPS_EXCEEDED",
          `Edge ${edge.id} would exceed maxHops.`,
          trace,
          checkpoints,
          artifacts,
          outputs,
          totals,
        );
      }

      if (nextTtl < 0) {
        return finalize(
          options,
          executable,
          "TTL_EXHAUSTED",
          `Edge ${edge.id} would exhaust TTL.`,
          trace,
          checkpoints,
          artifacts,
          outputs,
          totals,
        );
      }

      totals.hops += 1;
      queue.push({
        id: `${options.runId}:signal:${signalSequence}`,
        traceId: processedSignal.traceId,
        payloadRef: processedSignal.payloadRef,
        schema:
          binding.targetSchema.length > 0
            ? binding.targetSchema
            : processedSignal.schema,
        originNodeId: processedSignal.originNodeId,
        currentNodeId: edge.targetNodeId,
        hopCount: nextHopCount,
        ttl: nextTtl,
      });
      signalSequence += 1;
    }

    sequence += 1;
  }

  if (outputs.length === 0) {
    return finalize(
      options,
      executable,
      "NO_OUTPUT",
      "Execution finished without reaching an output node.",
      trace,
      checkpoints,
      artifacts,
      outputs,
      totals,
    );
  }

  return finalize(
    options,
    executable,
    "COMPLETED",
    "Execution completed deterministically.",
    trace,
    checkpoints,
    artifacts,
    outputs,
    totals,
  );
}

export function serializeRunReceipt(receipt: RunReceipt): string {
  return JSON.stringify(receipt);
}

export function deserializeRunReceipt(serialized: string): RunReceipt {
  return JSON.parse(serialized) as RunReceipt;
}
