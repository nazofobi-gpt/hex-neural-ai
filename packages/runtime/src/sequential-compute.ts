export type SequentialExitCode = "COMPLETED" | "MAX_DEPTH" | "REVISIT_LIMIT" | "TTL_EXPIRED" | "NO_PROGRESS";

export interface ExecutionFrame {
  frameId: string;
  payloadRef: string;
  residualState: Readonly<Record<string, number>>;
  phase: number;
  depth: number;
  ttl: number;
  trace: readonly string[];
}

export interface SequentialCluster {
  id: string;
  nextClusterId: string;
}

export interface SequentialCorridor {
  clusters: readonly SequentialCluster[];
  maxDepth: number;
  maxRevisitsPerCluster: number;
}

export interface SequentialStep {
  progress: number;
  residualDelta?: Readonly<Record<string, number>>;
  done?: boolean;
}

export interface SequentialRunResult {
  exitCode: SequentialExitCode;
  frame: ExecutionFrame;
}

function stableState(state: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)));
}

export function validateSequentialCorridor(corridor: SequentialCorridor): readonly string[] {
  const errors: string[] = [];
  if (corridor.clusters.length < 2) errors.push("MIN_TWO_CLUSTERS_REQUIRED");
  if (!Number.isSafeInteger(corridor.maxDepth) || corridor.maxDepth < 1) errors.push("INVALID_MAX_DEPTH");
  if (!Number.isSafeInteger(corridor.maxRevisitsPerCluster) || corridor.maxRevisitsPerCluster < 1) {
    errors.push("INVALID_REVISIT_LIMIT");
  }
  const ids = new Set(corridor.clusters.map(cluster => cluster.id));
  if (ids.size !== corridor.clusters.length) errors.push("DUPLICATE_CLUSTER_ID");
  for (const cluster of corridor.clusters) {
    if (!ids.has(cluster.nextClusterId)) errors.push(`UNKNOWN_NEXT_CLUSTER:${cluster.id}`);
    if (cluster.nextClusterId === cluster.id) errors.push(`SELF_LOOP:${cluster.id}`);
  }
  return errors.sort();
}

export function createExecutionFrame(
  frameId: string,
  payloadRef: string,
  residualState: Readonly<Record<string, number>>,
  ttl: number,
): ExecutionFrame {
  if (!frameId.trim() || !payloadRef.trim() || !Number.isSafeInteger(ttl) || ttl < 1) {
    throw new Error("INVALID_EXECUTION_FRAME");
  }
  return { frameId, payloadRef, residualState: stableState(residualState), phase: 0, depth: 0, ttl, trace: [] };
}

export function runSequentialCorridor(
  corridor: SequentialCorridor,
  initial: ExecutionFrame,
  desiredDepth: number,
  step: (clusterId: string, frame: ExecutionFrame) => SequentialStep,
): SequentialRunResult {
  if (validateSequentialCorridor(corridor).length) throw new Error("INVALID_SEQUENTIAL_CORRIDOR");
  if (!Number.isSafeInteger(desiredDepth) || desiredDepth < 1) throw new Error("INVALID_DESIRED_DEPTH");

  const byId = new Map(corridor.clusters.map(cluster => [cluster.id, cluster]));
  const revisit = new Map<string, number>();
  let currentId = corridor.clusters[0].id;
  let frame: ExecutionFrame = { ...initial, residualState: stableState(initial.residualState), trace: [...initial.trace] };

  while (frame.depth < desiredDepth) {
    if (frame.depth >= corridor.maxDepth) return { exitCode: "MAX_DEPTH", frame };
    if (frame.ttl <= 0) return { exitCode: "TTL_EXPIRED", frame };
    const visits = (revisit.get(currentId) ?? 0) + 1;
    revisit.set(currentId, visits);
    if (visits > corridor.maxRevisitsPerCluster) return { exitCode: "REVISIT_LIMIT", frame };

    const outcome = step(currentId, frame);
    if (!Number.isFinite(outcome.progress) || outcome.progress <= 0) return { exitCode: "NO_PROGRESS", frame };
    const residualState = stableState({ ...frame.residualState, ...(outcome.residualDelta ?? {}) });
    frame = {
      ...frame,
      residualState,
      phase: frame.phase + 1,
      depth: frame.depth + 1,
      ttl: frame.ttl - 1,
      trace: [...frame.trace, currentId],
    };
    if (outcome.done) return { exitCode: "COMPLETED", frame };
    currentId = byId.get(currentId)!.nextClusterId;
  }
  return { exitCode: "COMPLETED", frame };
}

export function checkpointExecutionFrame(frame: ExecutionFrame): string {
  return JSON.stringify({
    ...frame,
    residualState: stableState(frame.residualState),
    trace: [...frame.trace],
  });
}

export function restoreExecutionFrame(checkpoint: string): ExecutionFrame {
  const parsed = JSON.parse(checkpoint) as ExecutionFrame;
  if (!parsed.frameId?.trim() || !parsed.payloadRef?.trim() || !Number.isSafeInteger(parsed.depth) || !Number.isSafeInteger(parsed.ttl)) {
    throw new Error("INVALID_EXECUTION_CHECKPOINT");
  }
  return { ...parsed, residualState: stableState(parsed.residualState), trace: [...parsed.trace] };
}
