export type CheckpointTier = "micro" | "neural" | "full";

export interface RecoveryCheckpoint {
  id: string;
  tier: CheckpointTier;
  generation: number;
  journalOffset: number;
  createdAtMs: number;
  state: Record<string, unknown>;
  checksum: string;
}

export interface JournalEvent {
  offset: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface RecoveryMetrics {
  rpoEvents: number;
  rtoMs: number;
  pauseMs: number;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function checkpointChecksum(input: Omit<RecoveryCheckpoint, "checksum">): string {
  let hash = 2166136261;
  const text = stable(input);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createCheckpoint(input: Omit<RecoveryCheckpoint, "checksum">): RecoveryCheckpoint {
  return { ...structuredClone(input), checksum: checkpointChecksum(input) };
}

export function assertCheckpointValid(checkpoint: RecoveryCheckpoint): void {
  const { checksum, ...body } = checkpoint;
  if (checkpointChecksum(body) !== checksum) throw new Error("CHECKPOINT_CORRUPT");
}

export class FencedLease {
  #token = 0;
  #owner: string | null = null;

  transfer(owner: string): number {
    if (!owner) throw new Error("LEASE_OWNER_REQUIRED");
    this.#token += 1;
    this.#owner = owner;
    return this.#token;
  }

  assert(owner: string, token: number): void {
    if (owner !== this.#owner || token !== this.#token) throw new Error("STALE_GENERATION_FENCED");
  }

  snapshot(): { owner: string | null; token: number } {
    return { owner: this.#owner, token: this.#token };
  }
}

export class RecoveryRuntime {
  readonly #processed = new Set<string>();
  #state: Record<string, unknown> = {};
  #offset = 0;

  restore(checkpoint: RecoveryCheckpoint): void {
    assertCheckpointValid(checkpoint);
    this.#state = structuredClone(checkpoint.state);
    this.#offset = checkpoint.journalOffset;
  }

  replay(events: JournalEvent[]): { applied: number; duplicates: number } {
    let applied = 0;
    let duplicates = 0;
    for (const event of [...events].sort((a,b) => a.offset - b.offset)) {
      if (event.offset <= this.#offset || this.#processed.has(event.idempotencyKey)) {
        duplicates += 1;
        continue;
      }
      if (event.offset !== this.#offset + 1) throw new Error("JOURNAL_GAP");
      this.#state = { ...this.#state, ...structuredClone(event.payload) };
      this.#processed.add(event.idempotencyKey);
      this.#offset = event.offset;
      applied += 1;
    }
    return { applied, duplicates };
  }

  snapshot(): { state: Record<string, unknown>; offset: number } {
    return { state: structuredClone(this.#state), offset: this.#offset };
  }
}

export function measureRecovery(input: {
  checkpointOffset: number;
  durableTailOffset: number;
  recoveredOffset: number;
  failureAtMs: number;
  readyAtMs: number;
  trafficPauseStartMs: number;
  trafficResumeMs: number;
}): RecoveryMetrics {
  const values = Object.values(input);
  if (values.some((v) => !Number.isFinite(v) || v < 0)) throw new Error("RECOVERY_METRIC_INVALID");
  if (input.readyAtMs < input.failureAtMs || input.trafficResumeMs < input.trafficPauseStartMs) {
    throw new Error("RECOVERY_METRIC_INVALID");
  }
  return {
    rpoEvents: Math.max(0, input.durableTailOffset - input.recoveredOffset),
    rtoMs: input.readyAtMs - input.failureAtMs,
    pauseMs: input.trafficResumeMs - input.trafficPauseStartMs,
  };
}

export function warmHandoff(options: {
  oldGeneration: string;
  newGeneration: string;
  lease: FencedLease;
  checkpoint: RecoveryCheckpoint;
  tail: JournalEvent[];
}): { newToken: number; runtime: RecoveryRuntime; replayed: number } {
  if (options.oldGeneration === options.newGeneration) throw new Error("GENERATION_MUST_CHANGE");
  assertCheckpointValid(options.checkpoint);
  const runtime = new RecoveryRuntime();
  runtime.restore(options.checkpoint);
  const replay = runtime.replay(options.tail);
  const newToken = options.lease.transfer(options.newGeneration);
  return { newToken, runtime, replayed: replay.applied };
}
