import { isAdjacentOnFaces } from "./geometry.js";
import type { Connection, Face, HexCell, HnapGraph, SemanticChannel } from "./types.js";

export type ValidationCode =
  | "DUPLICATE_NODE_ID"
  | "DUPLICATE_CONNECTION_ID"
  | "DUPLICATE_COORDINATE"
  | "INVALID_FACE_INDEX"
  | "MISSING_CONNECTION_ENDPOINT"
  | "NON_ADJACENT_DIRECT_CONNECTION"
  | "MISSING_SOURCE_CHANNEL"
  | "MISSING_TARGET_CHANNEL"
  | "INCOMPATIBLE_CHANNEL_SCHEMA"
  | "UNBOUNDED_RUNTIME"
  | "MISSING_NEURAL_CIRCUIT"
  | "MISSING_CLUSTER_CHILD";

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

function channels(face: Face): Map<string, SemanticChannel> {
  return new Map(face.semanticChannels.map((channel) => [channel.id, channel]));
}

function validateConnection(
  connection: Connection,
  nodeById: Map<string, HexCell>,
  issues: ValidationIssue[],
): void {
  const source = nodeById.get(connection.source.nodeId);
  const target = nodeById.get(connection.target.nodeId);

  if (!source || !target) {
    issues.push({
      code: "MISSING_CONNECTION_ENDPOINT",
      message: `Connection ${connection.id} references a missing node endpoint.`,
      path: `connections.${connection.id}`,
    });
    return;
  }

  const sourceFace = source.faces[connection.source.faceIndex];
  const targetFace = target.faces[connection.target.faceIndex];

  if (!sourceFace || !targetFace) {
    issues.push({
      code: "INVALID_FACE_INDEX",
      message: `Connection ${connection.id} references an unavailable face.`,
      path: `connections.${connection.id}`,
    });
    return;
  }

  const longRange =
    source.kind === "axon" ||
    target.kind === "axon" ||
    connection.neuralBridgeRef !== null;

  if (
    !longRange &&
    !isAdjacentOnFaces(
      source.coordinate,
      connection.source.faceIndex,
      target.coordinate,
      connection.target.faceIndex,
    )
  ) {
    issues.push({
      code: "NON_ADJACENT_DIRECT_CONNECTION",
      message: `Connection ${connection.id} is direct but its cells are not on opposing adjacent faces.`,
      path: `connections.${connection.id}`,
    });
  }

  const sourceChannels = channels(sourceFace);
  const targetChannels = channels(targetFace);

  for (const binding of connection.semanticBindings) {
    const sourceChannel = sourceChannels.get(binding.sourceChannelId);
    const targetChannel = targetChannels.get(binding.targetChannelId);

    if (!sourceChannel) {
      issues.push({
        code: "MISSING_SOURCE_CHANNEL",
        message: `Binding ${binding.sourceChannelId} -> ${binding.targetChannelId} references a missing source channel.`,
        path: `connections.${connection.id}.semanticBindings`,
      });
      continue;
    }

    if (!targetChannel) {
      issues.push({
        code: "MISSING_TARGET_CHANNEL",
        message: `Binding ${binding.sourceChannelId} -> ${binding.targetChannelId} references a missing target channel.`,
        path: `connections.${connection.id}.semanticBindings`,
      });
      continue;
    }

    if (sourceChannel.schema !== targetChannel.schema && binding.transformRef === null) {
      issues.push({
        code: "INCOMPATIBLE_CHANNEL_SCHEMA",
        message: `Connection ${connection.id} binds incompatible schemas ${sourceChannel.schema} -> ${targetChannel.schema} without a transform.`,
        path: `connections.${connection.id}.semanticBindings`,
      });
    }
  }
}

export function validateGraph(graph: HnapGraph): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (
    graph.resourceBudget.maxHops < 1 ||
    graph.resourceBudget.maxRuntimeMs < 1 ||
    graph.resourceBudget.maxExternalCalls < 0
  ) {
    issues.push({
      code: "UNBOUNDED_RUNTIME",
      message: "Graph runtime guards must be finite and non-negative.",
      path: "resourceBudget",
    });
  }

  const nodeById = new Map<string, HexCell>();
  const occupiedCoordinates = new Map<string, string>();

  for (const node of graph.nodes) {
    if (nodeById.has(node.id)) {
      issues.push({
        code: "DUPLICATE_NODE_ID",
        message: `Duplicate node id: ${node.id}`,
        path: `nodes.${node.id}`,
      });
      continue;
    }

    nodeById.set(node.id, node);

    const coordinateKey = `${node.level}:${node.parentId ?? "root"}:${node.coordinate.q}:${node.coordinate.r}`;
    const existingNode = occupiedCoordinates.get(coordinateKey);

    if (existingNode) {
      issues.push({
        code: "DUPLICATE_COORDINATE",
        message: `Nodes ${existingNode} and ${node.id} occupy the same coordinate inside the same level/parent scope.`,
        path: `nodes.${node.id}.coordinate`,
      });
    } else {
      occupiedCoordinates.set(coordinateKey, node.id);
    }

    node.faces.forEach((face, index) => {
      if (face.index !== index) {
        issues.push({
          code: "INVALID_FACE_INDEX",
          message: `Node ${node.id} stores face index ${face.index} at tuple position ${index}.`,
          path: `nodes.${node.id}.faces.${index}`,
        });
      }
    });
  }

  const connectionIds = new Set<string>();

  for (const connection of graph.connections) {
    if (connectionIds.has(connection.id)) {
      issues.push({
        code: "DUPLICATE_CONNECTION_ID",
        message: `Duplicate connection id: ${connection.id}`,
        path: `connections.${connection.id}`,
      });
      continue;
    }

    connectionIds.add(connection.id);
    validateConnection(connection, nodeById, issues);
  }

  const neuralIds = new Set((graph.neuralCircuits ?? []).map((circuit) => circuit.id));

  for (const node of graph.nodes) {
    if (node.neuralCircuitRef !== null && !neuralIds.has(node.neuralCircuitRef)) {
      issues.push({
        code: "MISSING_NEURAL_CIRCUIT",
        message: `Node ${node.id} references missing neural circuit ${node.neuralCircuitRef}.`,
        path: `nodes.${node.id}.neuralCircuitRef`,
      });
    }
  }

  for (const cluster of graph.clusters ?? []) {
    for (const childId of cluster.childNodeIds) {
      if (!nodeById.has(childId)) {
        issues.push({
          code: "MISSING_CLUSTER_CHILD",
          message: `Cluster ${cluster.id} references missing child node ${childId}.`,
          path: `clusters.${cluster.id}.childNodeIds`,
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}