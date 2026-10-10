import type {
  Artifact,
  Connection,
  HnapGraph,
  HexCell,
  NodeKind,
  ResourceBudget,
} from "@hex-neural/protocol";

export type CompileErrorCode =
  | "GRAPH_INVALID"
  | "PERMISSION_REQUIRED"
  | "PERMISSION_DENIED"
  | "UNBOUNDED_COST"
  | "EXTERNAL_CALL_BUDGET_ZERO"
  | "NO_ENTRY_NODE"
  | "NO_OUTPUT_NODE";

export interface CompileError {
  code: CompileErrorCode;
  message: string;
  path?: string;
}

export interface RuntimePolicy {
  allowedPermissions: string[];
}

export interface ExecutableBinding {
  sourceChannelId: string;
  targetChannelId: string;
  sourceSchema: string;
  targetSchema: string;
  transformRef: string | null;
}

export interface ExecutableEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  bindings: ExecutableBinding[];
}

export interface ExecutableGraph {
  graphId: string;
  graphVersion: string;
  seed: number;
  nodes: HexCell[];
  edges: ExecutableEdge[];
  entryNodeIds: string[];
  outputNodeIds: string[];
  budget: ResourceBudget;
  policy: RuntimePolicy;
}

export type CompileResult =
  | { ok: true; executable: ExecutableGraph }
  | { ok: false; errors: CompileError[] };

export interface RuntimeSignal {
  id: string;
  traceId: string;
  payloadRef: string | null;
  schema: string | null;
  originNodeId: string;
  currentNodeId: string;
  hopCount: number;
  ttl: number;
}

export interface RuntimeAdapterContext {
  node: HexCell;
  signal: RuntimeSignal;
  seed: number;
  sequence: number;
}

export interface RuntimeArtifactDraft {
  id: string;
  mimeType: string;
  storageRef: string;
  sizeBytes?: number | null;
  hash?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProviderMeterV1 {
  /** The adapter's provider-supplied metered charge, NOT an estimate or costUnits. */
  amountUsd: number;
  /** Distinct provider billing/usage receipt reference for audit and deduplication. */
  receiptId: string;
  /** Exact provider/meter identity; never a private API key or raw payload. */
  source: string;
}

export interface RuntimeAdapterResult {
  payloadRef?: string | null;
  schema?: string | null;
  externalCalls?: number;
  costUnits?: number;
  durationMs?: number;
  providerMeter?: ProviderMeterV1;
  artifact?: RuntimeArtifactDraft | null;
}

export interface RuntimeAdapter {
  id: string;
  execute(context: RuntimeAdapterContext): RuntimeAdapterResult;
}

export interface RuntimeAdapterRegistry {
  byNodeId?: Record<string, RuntimeAdapter>;
  byKind?: Partial<Record<NodeKind, RuntimeAdapter>>;
}

export type RuntimeTerminationCode =
  | "COMPLETED"
  | "MAX_HOPS_EXCEEDED"
  | "TTL_EXHAUSTED"
  | "MAX_RUNTIME_EXCEEDED"
  | "MAX_EXTERNAL_CALLS_EXCEEDED"
  | "MAX_COST_EXCEEDED"
  | "ADAPTER_MISSING"
  | "ADAPTER_FAILED"
  | "RUNTIME_SCHEMA_MISMATCH"
  | "NO_OUTPUT";

export interface RuntimeTraceEvent {
  sequence: number;
  nodeId: string;
  nodeKind: NodeKind;
  signalId: string;
  traceId: string;
  payloadRef: string | null;
  schema: string | null;
  hopCount: number;
  ttl: number;
  adapterId: string;
  durationMs: number;
  externalCalls: number;
  costUnits: number;
  providerMeter?: ProviderMeterV1;
}

export interface RuntimeTotals {
  processedSignals: number;
  hops: number;
  runtimeMs: number;
  externalCalls: number;
  costUnits: number;
}

export interface RunCheckpoint {
  id: string;
  sequence: number;
  graphId: string;
  graphVersion: string;
  seed: number;
  signal: RuntimeSignal;
  totals: RuntimeTotals;
  traceLength: number;
}

export interface RuntimeArtifactReceipt extends Artifact {
  runId: string;
  nodeId: string;
  traceId: string;
  provenance: {
    graphId: string;
    graphVersion: string;
    seed: number;
    adapterId: string;
  };
}

export interface RunReceipt {
  runId: string;
  graphId: string;
  graphVersion: string;
  seed: number;
  status: "completed" | "terminated";
  termination: {
    code: RuntimeTerminationCode;
    message: string;
  };
  startedAt: string;
  completedAt: string;
  trace: RuntimeTraceEvent[];
  checkpoints: RunCheckpoint[];
  artifacts: RuntimeArtifactReceipt[];
  outputs: RuntimeSignal[];
  totals: RuntimeTotals;
}

export interface RunOptions {
  runId: string;
  startedAt: string;
  completedAt: string;
  initialPayloadRef: string | null;
  initialSchema: string | null;
  traceId?: string;
  entryNodeId?: string;
  adapters?: RuntimeAdapterRegistry;
}

export interface CompiledConnectionSource {
  graph: HnapGraph;
  connection: Connection;
}
