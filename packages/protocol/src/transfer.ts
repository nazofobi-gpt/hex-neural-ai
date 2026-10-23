import { isAdjacentOnFaces } from "./geometry.js";
import type {
  ChannelTransport,
  ConnectionEndpoint,
  Face,
  FaceIndex,
  HexCell,
  SemanticChannel,
} from "./types.js";

export type FaceTransferErrorCode =
  | "NON_ADJACENT"
  | "SOURCE_OUTPUT_DENIED"
  | "TARGET_INPUT_DENIED"
  | "NO_COMMON_CHANNEL"
  | "SCHEMA_MISMATCH"
  | "DISCONNECTED"
  | "SOURCE_MISMATCH"
  | "TTL_EXHAUSTED"
  | "ROUTE_BREAK";

export interface FaceTransferError {
  code: FaceTransferErrorCode;
  message: string;
}

export type FaceTransferResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: FaceTransferError };

export interface FaceTransferConnection {
  id: string;
  source: ConnectionEndpoint;
  target: ConnectionEndpoint;
  sourceChannelId: string;
  targetChannelId: string;
  schema: string;
  transport: ChannelTransport;
  state: "connected" | "disconnected";
  createdAt: string;
}

export interface SemanticEnvelope {
  id: string;
  traceId: string;
  payloadRef: string;
  schema: string;
  channelId: string;
  origin: ConnectionEndpoint;
  current: ConnectionEndpoint;
  hopCount: number;
  ttl: number;
  createdAt: string;
}

export interface NeuralControlFrame {
  traceId: string;
  gate: number;
  activation: number | null;
  sourceProjectionPopulation: string[];
  targetProjectionPopulation: string[];
}

export interface FaceTransferReceipt {
  semantic: SemanticEnvelope;
  neuralControl: NeuralControlFrame | null;
  connectionId: string;
}

export interface ConnectFaceOptions {
  id: string;
  sourceFaceIndex: FaceIndex;
  targetFaceIndex: FaceIndex;
  createdAt: string;
}

function isOutputDirection(channel: SemanticChannel): boolean {
  return channel.direction === "output" || channel.direction === "bidirectional";
}

function isInputDirection(channel: SemanticChannel): boolean {
  return channel.direction === "input" || channel.direction === "bidirectional";
}

function acceptsSchema(face: Face, schema: string): boolean {
  return face.acceptedSchemas.length === 0 || face.acceptedSchemas.includes(schema);
}

function compatiblePairs(
  sourceFace: Face,
  targetFace: Face,
): Array<{ source: SemanticChannel; target: SemanticChannel }> {
  const sourceChannels = sourceFace.semanticChannels.filter(isOutputDirection);
  const targetChannels = targetFace.semanticChannels.filter(isInputDirection);

  return sourceChannels
    .flatMap((source) =>
      targetChannels
        .filter(
          (target) =>
            source.schema === target.schema &&
            source.transport === target.transport &&
            acceptsSchema(sourceFace, source.schema) &&
            acceptsSchema(targetFace, source.schema),
        )
        .map((target) => ({ source, target })),
    )
    .sort((a, b) => {
      const aKey = `${a.source.id}\u0000${a.target.id}`;
      const bKey = `${b.source.id}\u0000${b.target.id}`;
      return aKey.localeCompare(bKey);
    });
}

function hasDirectionalChannels(sourceFace: Face, targetFace: Face): boolean {
  return (
    sourceFace.semanticChannels.some(isOutputDirection) &&
    targetFace.semanticChannels.some(isInputDirection)
  );
}

export function connectFaces(
  source: HexCell,
  target: HexCell,
  options: ConnectFaceOptions,
): FaceTransferResult<FaceTransferConnection> {
  const sourceFace = source.faces[options.sourceFaceIndex];
  const targetFace = target.faces[options.targetFaceIndex];

  if (
    !isAdjacentOnFaces(
      source.coordinate,
      options.sourceFaceIndex,
      target.coordinate,
      options.targetFaceIndex,
    )
  ) {
    return {
      ok: false,
      error: {
        code: "NON_ADJACENT",
        message: `Cannot connect ${source.id}:${options.sourceFaceIndex} to ${target.id}:${options.targetFaceIndex}; faces are not opposing direct neighbors.`,
      },
    };
  }

  if (sourceFace.outputPolicy === "deny") {
    return {
      ok: false,
      error: {
        code: "SOURCE_OUTPUT_DENIED",
        message: `Source face ${source.id}:${options.sourceFaceIndex} denies semantic output.`,
      },
    };
  }

  if (targetFace.inputPolicy === "deny") {
    return {
      ok: false,
      error: {
        code: "TARGET_INPUT_DENIED",
        message: `Target face ${target.id}:${options.targetFaceIndex} denies semantic input.`,
      },
    };
  }

  const pairs = compatiblePairs(sourceFace, targetFace);

  if (pairs.length === 0) {
    const code: FaceTransferErrorCode = hasDirectionalChannels(
      sourceFace,
      targetFace,
    )
      ? "SCHEMA_MISMATCH"
      : "NO_COMMON_CHANNEL";

    return {
      ok: false,
      error: {
        code,
        message:
          code === "SCHEMA_MISMATCH"
            ? `No schema/transport-compatible channel pair exists for ${source.id}:${options.sourceFaceIndex} -> ${target.id}:${options.targetFaceIndex}.`
            : `No output-to-input semantic channel pair exists for ${source.id}:${options.sourceFaceIndex} -> ${target.id}:${options.targetFaceIndex}.`,
      },
    };
  }

  const pair = pairs[0]!;

  return {
    ok: true,
    value: {
      id: options.id,
      source: {
        nodeId: source.id,
        faceIndex: options.sourceFaceIndex,
      },
      target: {
        nodeId: target.id,
        faceIndex: options.targetFaceIndex,
      },
      sourceChannelId: pair.source.id,
      targetChannelId: pair.target.id,
      schema: pair.source.schema,
      transport: pair.source.transport,
      state: "connected",
      createdAt: options.createdAt,
    },
  };
}

export function disconnectFaceConnection(
  connection: FaceTransferConnection,
): FaceTransferConnection {
  return {
    ...connection,
    state: "disconnected",
  };
}

export function transferSemantic(
  connection: FaceTransferConnection,
  envelope: SemanticEnvelope,
  sourceFace: Face,
  targetFace: Face,
  neuralControl: NeuralControlFrame | null = null,
): FaceTransferResult<FaceTransferReceipt> {
  if (connection.state !== "connected") {
    return {
      ok: false,
      error: {
        code: "DISCONNECTED",
        message: `Connection ${connection.id} is disconnected.`,
      },
    };
  }

  if (envelope.ttl <= 0) {
    return {
      ok: false,
      error: {
        code: "TTL_EXHAUSTED",
        message: `Signal ${envelope.id} has exhausted its TTL.`,
      },
    };
  }

  if (envelope.current.nodeId !== connection.source.nodeId) {
    return {
      ok: false,
      error: {
        code: "SOURCE_MISMATCH",
        message: `Signal ${envelope.id} is at node ${envelope.current.nodeId}, not connection source ${connection.source.nodeId}.`,
      },
    };
  }

  if (
    envelope.schema !== connection.schema ||
    envelope.channelId !== connection.sourceChannelId ||
    !acceptsSchema(sourceFace, envelope.schema) ||
    !acceptsSchema(targetFace, envelope.schema)
  ) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_MISMATCH",
        message: `Signal ${envelope.id} is incompatible with connection ${connection.id}.`,
      },
    };
  }

  const semantic: SemanticEnvelope = {
    ...envelope,
    channelId: connection.targetChannelId,
    current: {
      nodeId: connection.target.nodeId,
      faceIndex: connection.target.faceIndex,
    },
    hopCount: envelope.hopCount + 1,
    ttl: envelope.ttl - 1,
  };

  const nextControl =
    neuralControl === null
      ? null
      : {
          ...neuralControl,
          traceId: envelope.traceId,
          sourceProjectionPopulation: [...sourceFace.projectionPopulation],
          targetProjectionPopulation: [...targetFace.projectionPopulation],
        };

  return {
    ok: true,
    value: {
      semantic,
      neuralControl: nextControl,
      connectionId: connection.id,
    },
  };
}

export interface RelayHop {
  connection: FaceTransferConnection;
  sourceFace: Face;
  targetFace: Face;
  neuralControl?: NeuralControlFrame | null;
}

export function relaySemantic(
  envelope: SemanticEnvelope,
  hops: readonly RelayHop[],
): FaceTransferResult<FaceTransferReceipt[]> {
  const receipts: FaceTransferReceipt[] = [];
  let current = envelope;

  for (const hop of hops) {
    if (hop.connection.source.nodeId !== current.current.nodeId) {
      return {
        ok: false,
        error: {
          code: "ROUTE_BREAK",
          message: `Relay route breaks at connection ${hop.connection.id}; expected source node ${current.current.nodeId}, got ${hop.connection.source.nodeId}.`,
        },
      };
    }

    const routedEnvelope: SemanticEnvelope = {
      ...current,
      channelId: hop.connection.sourceChannelId,
      current: {
        nodeId: current.current.nodeId,
        faceIndex: hop.connection.source.faceIndex,
      },
    };

    const result = transferSemantic(
      hop.connection,
      routedEnvelope,
      hop.sourceFace,
      hop.targetFace,
      hop.neuralControl ?? null,
    );

    if (!result.ok) {
      return result;
    }

    receipts.push(result.value);
    current = result.value.semantic;
  }

  return { ok: true, value: receipts };
}
