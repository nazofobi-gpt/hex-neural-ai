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

function validAdapterMetric(value: unknown, requireSafeInteger = false): boolean {
  return value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0 &&
      (!requireSafeInteger || Number.isSafeInteger(value)));
}

/**
 * Never trust adapter-supplied object accessors. Snapshot only own data
 * properties before using the result in billing, traces or run receipts.
 * This also rejects throwing Proxy descriptor traps without exposing errors.
 */
function snapshotAdapterResult(value: RuntimeAdapterResult): RuntimeAdapterResult {
  function ownData(object: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined) return undefined;
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error("Adapter result contains an accessor property.");
    }
    return descriptor.value;
  }
  function plainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
  if (!plainRecord(value)) throw new Error("Invalid adapter result.");
  const meter = ownData(value, "providerMeter");
  const artifact = ownData(value, "artifact");
  if (meter !== undefined && !plainRecord(meter)) {
    throw new Error("Invalid adapter meter.");
  }
  if (artifact !== undefined && artifact !== null && !plainRecord(artifact)) {
    throw new Error("Invalid adapter artifact.");
  }
  const metadata = artifact && plainRecord(artifact) ? ownData(artifact, "metadata") : undefined;
  if (metadata !== undefined && !plainRecord(metadata)) {
    throw new Error("Invalid adapter artifact metadata.");
  }
  // Clone nested JSON metadata before it reaches run receipt serialization.
  // Do not invoke adapter-controlled getters, proxies or toJSON methods.
  const visited = new WeakSet<object>();
  let visitedNodes = 0;
  function snapshotJson(value: unknown, depth = 0): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value === undefined) return undefined;
    if (typeof value !== "object" || depth >= 16 || ++visitedNodes > 2048) {
      throw new Error("Unsafe adapter metadata value.");
    }
    if (visited.has(value)) throw new Error("Cyclic adapter metadata.");
    visited.add(value);
    try {
      if (Array.isArray(value)) {
        const length = ownData(value, "length");
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length > 2048) {
          throw new Error("Invalid adapter metadata array.");
        }
        const copy: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          copy.push(snapshotJson(ownData(value, String(index)), depth + 1));
        }
        return copy;
      }
      if (!plainRecord(value)) throw new Error("Invalid nested adapter metadata.");
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        Object.defineProperty(copy, key, {
          value: snapshotJson(ownData(value, key), depth + 1),
          enumerable: true, writable: true, configurable: true,
        });
      }
      return copy;
    } finally {
      visited.delete(value);
    }
  }
  const safeMetadata: Record<string, unknown> = metadata === undefined
    ? {} : snapshotJson(metadata) as Record<string, unknown>;
  return {
    payloadRef: ownData(value, "payloadRef") as RuntimeAdapterResult["payloadRef"],
    schema: ownData(value, "schema") as RuntimeAdapterResult["schema"],
    durationMs: ownData(value, "durationMs") as number | undefined,
    externalCalls: ownData(value, "externalCalls") as number | undefined,
    costUnits: ownData(value, "costUnits") as number | undefined,
    ...(meter === undefined ? {} : {
      providerMeter: {
        amountUsd: ownData(meter as object, "amountUsd") as number,
        receiptId: ownData(meter as object, "receiptId") as string,
        source: ownData(meter as object, "source") as string,
      },
    }),
    ...(artifact === undefined ? {} : {
      artifact: artifact === null ? null : {
        id: ownData(artifact as object, "id") as string,
        mimeType: ownData(artifact as object, "mimeType") as string,
        storageRef: ownData(artifact as object, "storageRef") as string,
        sizeBytes: ownData(artifact as object, "sizeBytes") as number | null | undefined,
        hash: ownData(artifact as object, "hash") as string | null | undefined,
        ...(metadata === undefined ? {} : { metadata: safeMetadata }),
      },
    }),
  };
}

function normalizedAdapterResult(
  result: RuntimeAdapterResult,
  signal: RuntimeSignal,
): Required<Omit<RuntimeAdapterResult, "artifact" | "providerMeter">> & {
  artifact: RuntimeAdapterResult["artifact"];
  providerMeter: RuntimeAdapterResult["providerMeter"];
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
    providerMeter: result.providerMeter === undefined ? undefined : { ...result.providerMeter },
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
  // Provider billing receipt IDs must be unique within a run. A repeated
  // receipt cannot represent a second independently billed external call.
  const seenProviderReceipts = new Set<string>();
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
      rawResult = snapshotAdapterResult(adapter.execute({
        node,
        signal: { ...signal },
        seed: executable.seed,
        sequence,
      }));
    } catch {
      // Never inspect or stringify adapter-thrown values: Error.message,
      // toString and coercion hooks can disclose secrets or execute code.
      return finalize(
        options,
        executable,
        "ADAPTER_FAILED",
        "Runtime adapter execution failed; details withheld from run receipts.",
        trace,
        checkpoints,
        artifacts,
        outputs,
        totals,
      );
    }

    const invalidMetric = (["durationMs", "externalCalls", "costUnits"] as const)
      .find((key) => !validAdapterMetric(rawResult[key], key === "externalCalls"));
    if (invalidMetric !== undefined) {
      return finalize(
        options,
        executable,
        "ADAPTER_FAILED",
        `Adapter ${adapter.id} returned invalid ${invalidMetric} at node ${node.id}.`,
        trace,
        checkpoints,
        artifacts,
        outputs,
        totals,
      );
    }

    // Metered USD must come from a concrete external adapter billing receipt.
    // costUnits are not currency; a missing receipt remains UNKNOWN downstream.
    if (rawResult.providerMeter !== undefined) {
      const meter = rawResult.providerMeter;
      const valid = meter !== null && typeof meter === "object" &&
        typeof meter.amountUsd === "number" &&
        Number.isFinite(meter.amountUsd) && meter.amountUsd >= 0 &&
        typeof meter.receiptId === "string" && meter.receiptId.trim().length > 0 &&
        typeof meter.source === "string" && meter.source.trim().length > 0 &&
        rawResult.externalCalls === 1 &&
        !seenProviderReceipts.has(meter.receiptId);
      if (!valid) {
        return finalize(
          options, executable, "ADAPTER_FAILED",
          `Adapter ${adapter.id} returned invalid providerMeter at node ${node.id}.`,
          trace, checkpoints, artifacts, outputs, totals,
        );
      }
    }

    const result = normalizedAdapterResult(rawResult, signal);
    const nextRuntimeMs = totals.runtimeMs + result.durationMs;
    const nextExternalCalls = totals.externalCalls + result.externalCalls;
    const nextCostUnits = totals.costUnits + result.costUnits;
    if (![nextRuntimeMs, nextCostUnits].every(Number.isFinite) ||
        !Number.isSafeInteger(nextExternalCalls)) {
      return finalize(
        options,
        executable,
        "ADAPTER_FAILED",
        `Adapter ${adapter.id} caused non-finite cumulative metrics at node ${node.id}.`,
        trace,
        checkpoints,
        artifacts,
        outputs,
        totals,
      );
    }

    if (result.providerMeter !== undefined) {
      seenProviderReceipts.add(result.providerMeter.receiptId);
    }

    totals.processedSignals += 1;
    totals.runtimeMs = nextRuntimeMs;
    totals.externalCalls = nextExternalCalls;
    totals.costUnits = nextCostUnits;

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
      ...(result.providerMeter === undefined ? {} : { providerMeter: { ...result.providerMeter } }),
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
