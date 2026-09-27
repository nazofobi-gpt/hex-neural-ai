export const DISTRIBUTED_PROTOCOL_VERSION = "0.1" as const;

export type DeliveryClass = "at_most_once" | "idempotent";
export type CapabilityState = "ready" | "draining" | "unavailable";

export interface ClusterIdentity {
  clusterId: string;
  namespace: string;
  protocolVersion: typeof DISTRIBUTED_PROTOCOL_VERSION;
}

export interface ReplicaIdentity {
  logicalId: string;
  replicaId: string;
  generation: number;
  providerId: string;
}

export interface CapabilityContract {
  id: string;
  version: string;
  inputSchemas: string[];
  outputSchemas: string[];
  maxInFlight: number;
}

export interface CapabilityRegistration {
  capability: CapabilityContract;
  replica: ReplicaIdentity;
  state: CapabilityState;
}

export interface FunctionalRegion {
  id: string;
  version: string;
  memberLogicalIds: string[];
}

export interface RegionProjection {
  regionId: string;
  faceIndex: 0 | 1 | 2 | 3 | 4 | 5;
  capabilityIds: string[];
}

export interface MessageEnvelope<T = unknown> {
  protocolVersion: typeof DISTRIBUTED_PROTOCOL_VERSION;
  messageId: string;
  idempotencyKey: string;
  namespace: string;
  sourceLogicalId: string;
  targetLogicalId: string;
  capabilityId: string;
  capabilityVersion: string;
  generation: number;
  delivery: DeliveryClass;
  payload: T;
}

export interface ComputeProvider {
  id: string;
  kind: string;
  labels: Record<string, string>;
}

export interface StateFence {
  namespace: string;
  ownerLogicalId: string;
  generation: number;
  token: string;
}

export interface BackpressurePolicy {
  maxInFlight: number;
  maxQueueDepth: number;
}

export class CapabilityRegistry {
  readonly #entries = new Map<string, CapabilityRegistration>();

  register(entry: CapabilityRegistration): void {
    if (entry.capability.maxInFlight < 1) {
      throw new Error("maxInFlight must be >= 1");
    }
    this.#entries.set(entry.capability.id, entry);
  }

  resolve(id: string, version: string): CapabilityRegistration | null {
    const entry = this.#entries.get(id);
    return entry?.capability.version === version && entry.state === "ready"
      ? entry
      : null;
  }
}

export type DispatchErrorCode =
  | "NAMESPACE_MISMATCH"
  | "CAPABILITY_UNAVAILABLE"
  | "TARGET_MISMATCH"
  | "STALE_GENERATION"
  | "FENCE_REJECTED"
  | "DUPLICATE_MESSAGE"
  | "BACKPRESSURE";

export type DispatchResult<T> =
  | { ok: true; value: T; duplicate: false }
  | { ok: true; value: T; duplicate: true }
  | { ok: false; error: { code: DispatchErrorCode; message: string } };

export interface SingleNodeAdapterOptions {
  cluster: ClusterIdentity;
  replica: ReplicaIdentity;
  registry: CapabilityRegistry;
  backpressure: BackpressurePolicy;
  fence?: StateFence | null;
}

export class InMemorySingleNodeAdapter {
  readonly #cluster: ClusterIdentity;
  readonly #replica: ReplicaIdentity;
  readonly #registry: CapabilityRegistry;
  readonly #backpressure: BackpressurePolicy;
  #fence: StateFence | null;
  #inFlight = 0;
  readonly #queued = new Set<string>();
  readonly #completed = new Map<string, unknown>();

  constructor(options: SingleNodeAdapterOptions) {
    if (options.backpressure.maxInFlight < 1) {
      throw new Error("maxInFlight must be >= 1");
    }
    if (options.backpressure.maxQueueDepth < 0) {
      throw new Error("maxQueueDepth must be >= 0");
    }
    this.#cluster = options.cluster;
    this.#replica = options.replica;
    this.#registry = options.registry;
    this.#backpressure = options.backpressure;
    this.#fence = options.fence ?? null;
  }

  setFence(fence: StateFence | null): void {
    this.#fence = fence;
  }

  dispatch<T, R>(
    envelope: MessageEnvelope<T>,
    handler: (payload: T) => R,
  ): DispatchResult<R> {
    const duplicate = this.#completed.get(envelope.idempotencyKey);
    if (duplicate !== undefined) {
      if (envelope.delivery === "idempotent") {
        return { ok: true, value: duplicate as R, duplicate: true };
      }
      return this.#reject("DUPLICATE_MESSAGE", envelope.messageId);
    }

    const validation = this.#validate(envelope);
    if (validation !== null) {
      return validation;
    }

    if (this.#inFlight >= this.#backpressure.maxInFlight) {
      if (this.#queued.size >= this.#backpressure.maxQueueDepth) {
        return this.#reject("BACKPRESSURE", envelope.messageId);
      }
      this.#queued.add(envelope.idempotencyKey);
      return this.#reject("BACKPRESSURE", envelope.messageId);
    }

    this.#queued.delete(envelope.idempotencyKey);
    this.#inFlight += 1;
    try {
      const value = handler(envelope.payload);
      this.#completed.set(envelope.idempotencyKey, value);
      return { ok: true, value, duplicate: false };
    } finally {
      this.#inFlight -= 1;
    }
  }

  #validate<T>(envelope: MessageEnvelope<T>): DispatchResult<never> | null {
    if (
      envelope.namespace !== this.#cluster.namespace ||
      this.#replica.logicalId.split("/")[0] !== envelope.namespace
    ) {
      return this.#reject("NAMESPACE_MISMATCH", envelope.messageId);
    }
    if (envelope.targetLogicalId !== this.#replica.logicalId) {
      return this.#reject("TARGET_MISMATCH", envelope.messageId);
    }
    if (envelope.generation !== this.#replica.generation) {
      return this.#reject("STALE_GENERATION", envelope.messageId);
    }
    const registration = this.#registry.resolve(
      envelope.capabilityId,
      envelope.capabilityVersion,
    );
    if (
      registration === null ||
      registration.replica.logicalId !== this.#replica.logicalId ||
      registration.replica.generation !== this.#replica.generation
    ) {
      return this.#reject("CAPABILITY_UNAVAILABLE", envelope.messageId);
    }
    if (
      this.#fence !== null &&
      (this.#fence.namespace !== envelope.namespace ||
        this.#fence.ownerLogicalId !== envelope.targetLogicalId ||
        this.#fence.generation !== envelope.generation)
    ) {
      return this.#reject("FENCE_REJECTED", envelope.messageId);
    }
    return null;
  }

  #reject(code: DispatchErrorCode, messageId: string): DispatchResult<never> {
    return {
      ok: false,
      error: { code, message: `${code}: message ${messageId} rejected` },
    };
  }
}
