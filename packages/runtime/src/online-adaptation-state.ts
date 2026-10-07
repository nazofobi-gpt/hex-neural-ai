import {
  resetBridgeFastState,
  type BridgeCandidate,
  type BridgePolicyState,
  type ContextVector,
} from "./bridge-adaptation.js";

export interface ReplayExample {
  readonly id: string;
  readonly context: ContextVector;
  readonly candidates: readonly BridgeCandidate[];
  readonly expectedCandidateId: string;
  readonly rewards: Readonly<Record<string, number>>;
  readonly cohort: "old" | "new";
}

export class BoundedReplayReservoir {
  readonly #capacity: number;
  #items: ReplayExample[] = [];

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("REPLAY_CAPACITY_INVALID");
    }
    this.#capacity = capacity;
  }

  push(example: ReplayExample): void {
    const index = this.#items.findIndex(item => item.id === example.id);
    if (index >= 0) this.#items.splice(index, 1);
    this.#items.push(structuredClone(example));
    if (this.#items.length > this.#capacity) {
      this.#items.splice(0, this.#items.length - this.#capacity);
    }
  }

  snapshot(): readonly ReplayExample[] {
    return structuredClone(this.#items);
  }

  get size(): number {
    return this.#items.length;
  }

  get capacity(): number {
    return this.#capacity;
  }
}

export interface RegionLearnerSnapshot {
  readonly regionId: string;
  readonly ownerId: string;
  readonly ownerEpoch: number;
  readonly version: number;
  readonly state: BridgePolicyState;
}

export interface RegionLearnerDelta {
  readonly regionId: string;
  readonly ownerId: string;
  readonly ownerEpoch: number;
  readonly baseVersion: number;
  readonly nextVersion: number;
  readonly nextState: BridgePolicyState;
}

export type RegionDeltaResult =
  | { ok: true; value: RegionLearnerSnapshot }
  | { ok: false; code: "STALE_DELTA_OWNER" | "DELTA_VERSION_MISMATCH" | "INVALID_DELTA" };

export function commitRegionLearnerDelta(
  current: RegionLearnerSnapshot,
  delta: RegionLearnerDelta,
): RegionDeltaResult {
  if (
    current.regionId !== delta.regionId ||
    current.ownerId !== delta.ownerId ||
    current.ownerEpoch !== delta.ownerEpoch
  ) {
    return { ok: false, code: "STALE_DELTA_OWNER" };
  }
  if (current.version !== delta.baseVersion || delta.nextVersion !== current.version + 1) {
    return { ok: false, code: "DELTA_VERSION_MISMATCH" };
  }
  if (
    !delta.regionId.trim() ||
    !delta.ownerId.trim() ||
    !Number.isSafeInteger(delta.ownerEpoch) ||
    delta.ownerEpoch < 0 ||
    !Number.isSafeInteger(delta.nextVersion) ||
    delta.nextVersion < 1
  ) {
    return { ok: false, code: "INVALID_DELTA" };
  }
  return {
    ok: true,
    value: {
      regionId: current.regionId,
      ownerId: current.ownerId,
      ownerEpoch: current.ownerEpoch,
      version: delta.nextVersion,
      state: structuredClone(delta.nextState),
    },
  };
}

export function serializeCommittedRegionLearner(snapshot: RegionLearnerSnapshot): string {
  return JSON.stringify(snapshot);
}

export function restartCommittedRegionLearner(serialized: string): RegionLearnerSnapshot {
  const parsed = JSON.parse(serialized) as RegionLearnerSnapshot;
  if (
    !parsed.regionId?.trim() ||
    !parsed.ownerId?.trim() ||
    !Number.isSafeInteger(parsed.ownerEpoch) ||
    parsed.ownerEpoch < 0 ||
    !Number.isSafeInteger(parsed.version) ||
    parsed.version < 0 ||
    !parsed.state ||
    typeof parsed.state.weights !== "object"
  ) {
    throw new Error("COMMITTED_LEARNER_INVALID");
  }
  return {
    ...structuredClone(parsed),
    state: resetBridgeFastState(parsed.state),
  };
}
