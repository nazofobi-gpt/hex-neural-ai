import type { FunctionalRegion, RegionProjection } from "./distributed.js";

export const EDGE_FABRIC_CONTRACT_VERSION = "0.1" as const;

export type EdgeCapabilityKind = "screen" | "microphone" | "speaker" | "touch";
export type PrivacyIndicator = "visual" | "audible" | "visual_and_audible";

export interface EdgeCapabilityScope {
  capabilityId: string;
  kind: EdgeCapabilityKind;
  regionId: string;
  workerLogicalId: string;
  privacy: {
    requiresIndicator: boolean;
    indicator: PrivacyIndicator;
  };
}

export interface EdgePacketBase {
  streamId: string;
  sequence: number;
  timestampMs: number;
}

export interface ScreenFrame extends EdgePacketBase {
  kind: "screen";
  mode: "full" | "delta";
  frameRef: string;
  roi?: { x: number; y: number; width: number; height: number };
}

export interface AudioChunk extends EdgePacketBase {
  kind: "audio";
  chunkRef: string;
  startMs: number;
  endMs: number;
  overlapMs: number;
}

export type EdgePacket = ScreenFrame | AudioChunk;

export class EdgeGatewayMock {
  #connected = true;
  readonly #maxBufferPerStream: number;
  readonly #buffers = new Map<string, EdgePacket[]>();

  constructor(maxBufferPerStream = 8) {
    if (!Number.isInteger(maxBufferPerStream) || maxBufferPerStream < 1) {
      throw new Error("EDGE_BUFFER_INVALID");
    }
    this.#maxBufferPerStream = maxBufferPerStream;
  }

  disconnect(): void {
    this.#connected = false;
  }

  reconnect(): void {
    this.#connected = true;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  ingest(packet: EdgePacket): void {
    if (!this.#connected) throw new Error("EDGE_DISCONNECTED");
    if (!Number.isInteger(packet.sequence) || packet.sequence < 0 || packet.timestampMs < 0) {
      throw new Error("EDGE_PACKET_INVALID");
    }
    if (packet.kind === "screen") {
      if (!packet.frameRef) throw new Error("SCREEN_FRAME_REF_REQUIRED");
      if (packet.roi && (packet.roi.width <= 0 || packet.roi.height <= 0)) {
        throw new Error("SCREEN_ROI_INVALID");
      }
    } else {
      if (!packet.chunkRef || packet.startMs < 0 || packet.endMs <= packet.startMs || packet.overlapMs < 0) {
        throw new Error("AUDIO_CHUNK_INVALID");
      }
    }

    const buffer = this.#buffers.get(packet.streamId) ?? [];
    const previous = buffer.at(-1);
    if (previous && packet.sequence <= previous.sequence) {
      throw new Error("EDGE_SEQUENCE_OUT_OF_ORDER");
    }
    buffer.push(structuredClone(packet));
    while (buffer.length > this.#maxBufferPerStream) buffer.shift();
    this.#buffers.set(packet.streamId, buffer);
  }

  read(streamId: string): EdgePacket[] {
    return (this.#buffers.get(streamId) ?? []).map((packet) => structuredClone(packet));
  }
}

export function computeAudioOverlapMs(previous: AudioChunk, next: AudioChunk): number {
  return Math.max(0, previous.endMs - next.startMs);
}

export class RegionCapabilityFabric {
  readonly #workers: Set<string>;
  readonly #regions: Map<string, FunctionalRegion>;
  readonly #projections: Map<string, RegionProjection>;
  readonly #scopes: Map<string, EdgeCapabilityScope>;

  constructor(options: {
    workers: string[];
    regions: FunctionalRegion[];
    projections: RegionProjection[];
    scopes: EdgeCapabilityScope[];
  }) {
    this.#workers = new Set(options.workers);
    if (this.#workers.size < 3) throw new Error("THREE_WORKERS_REQUIRED");
    this.#regions = new Map(options.regions.map((region) => [region.id, region]));
    this.#projections = new Map(options.projections.map((projection) => [projection.regionId, projection]));
    this.#scopes = new Map(options.scopes.map((scope) => [scope.capabilityId, scope]));

    for (const scope of options.scopes) {
      const region = this.#regions.get(scope.regionId);
      const projection = this.#projections.get(scope.regionId);
      if (!this.#workers.has(scope.workerLogicalId)) throw new Error("WORKER_NOT_ENROLLED");
      if (!region || !region.memberLogicalIds.includes(scope.workerLogicalId)) {
        throw new Error("REGION_LOCALITY_REJECTED");
      }
      if (!projection || !projection.capabilityIds.includes(scope.capabilityId)) {
        throw new Error("ASSOCIATION_PROJECTION_MISSING");
      }
    }
  }

  resolve(capabilityId: string): EdgeCapabilityScope | null {
    const scope = this.#scopes.get(capabilityId);
    return scope ? structuredClone(scope) : null;
  }

  projectionFor(capabilityId: string): RegionProjection | null {
    const scope = this.#scopes.get(capabilityId);
    if (!scope) return null;
    const projection = this.#projections.get(scope.regionId);
    return projection ? structuredClone(projection) : null;
  }

  assertPrivacyIndicator(capabilityId: string, indicatorActive: boolean): void {
    const scope = this.#scopes.get(capabilityId);
    if (!scope) throw new Error("CAPABILITY_SCOPE_UNKNOWN");
    if (scope.privacy.requiresIndicator && !indicatorActive) {
      throw new Error("PRIVACY_INDICATOR_REQUIRED");
    }
  }
}

export interface TouchResult<T> {
  value: T;
  duplicate: boolean;
}

export interface SpeakerCommand {
  actionId: string;
  sequence: number;
  audioRef: string;
  interrupt: boolean;
}

export interface SpeakerReceipt {
  actionId: string;
  sequence: number;
  state: "playing" | "interrupted";
  interruptedBy?: string;
}

export class ActionCoordinator {
  readonly #touchReceipts = new Map<string, unknown>();
  readonly #speakerReceipts: SpeakerReceipt[] = [];
  #activeSpeaker: SpeakerReceipt | null = null;
  #speakerSequence = -1;

  touch<T>(actionId: string, effect: () => T): TouchResult<T> {
    if (!actionId) throw new Error("ACTION_ID_REQUIRED");
    if (this.#touchReceipts.has(actionId)) {
      return { value: this.#touchReceipts.get(actionId) as T, duplicate: true };
    }
    const value = effect();
    this.#touchReceipts.set(actionId, value);
    return { value, duplicate: false };
  }

  play(command: SpeakerCommand): { receipt: SpeakerReceipt; duplicate: boolean } {
    if (!command.actionId || !command.audioRef || !Number.isInteger(command.sequence)) {
      throw new Error("SPEAKER_COMMAND_INVALID");
    }
    const prior = this.#speakerReceipts.find((receipt) => receipt.actionId === command.actionId);
    if (prior) return { receipt: structuredClone(prior), duplicate: true };
    if (command.sequence <= this.#speakerSequence) throw new Error("SPEAKER_SEQUENCE_OUT_OF_ORDER");
    if (this.#activeSpeaker && !command.interrupt) throw new Error("SPEAKER_BUSY");

    if (this.#activeSpeaker) {
      this.#activeSpeaker.state = "interrupted";
      this.#activeSpeaker.interruptedBy = command.actionId;
    }

    const receipt: SpeakerReceipt = {
      actionId: command.actionId,
      sequence: command.sequence,
      state: "playing",
    };
    this.#speakerSequence = command.sequence;
    this.#speakerReceipts.push(receipt);
    this.#activeSpeaker = receipt;
    return { receipt: structuredClone(receipt), duplicate: false };
  }

  speakerHistory(): SpeakerReceipt[] {
    return this.#speakerReceipts.map((receipt) => structuredClone(receipt));
  }
}
