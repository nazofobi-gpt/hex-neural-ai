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
