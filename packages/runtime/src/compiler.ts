import { validateGraph } from "@hex-neural/protocol";
import type {
  Connection,
  HexCell,
  HnapGraph,
  SemanticChannel,
} from "@hex-neural/protocol";
import type {
  CompileError,
  CompileResult,
  ExecutableBinding,
  ExecutableEdge,
  ExecutableGraph,
  RuntimePolicy,
} from "./types.js";

function permissionOf(node: HexCell): string | null {
  const permission = node.config.permission;
  return typeof permission === "string" && permission.length > 0
    ? permission
    : null;
}

function channelById(
  node: HexCell,
  faceIndex: number,
  channelId: string,
): SemanticChannel | null {
  const face = node.faces[faceIndex];
  return (
    face.semanticChannels.find((channel) => channel.id === channelId) ??
    null
  );
}

function compileEdge(
  graph: HnapGraph,
  connection: Connection,
): ExecutableEdge {
  const source = graph.nodes.find(
    (node) => node.id === connection.source.nodeId,
  )!;
  const target = graph.nodes.find(
    (node) => node.id === connection.target.nodeId,
  )!;

  const bindings: ExecutableBinding[] = connection.semanticBindings
    .map((binding) => {
      const sourceChannel = channelById(
        source,
        connection.source.faceIndex,
        binding.sourceChannelId,
      )!;
      const targetChannel = channelById(
        target,
        connection.target.faceIndex,
        binding.targetChannelId,
      )!;

      return {
        sourceChannelId: binding.sourceChannelId,
        targetChannelId: binding.targetChannelId,
        sourceSchema: sourceChannel.schema,
        targetSchema: targetChannel.schema,
        transformRef: binding.transformRef,
      };
    })
    .sort((a, b) => {
      const aKey = `${a.sourceChannelId}\u0000${a.targetChannelId}`;
      const bKey = `${b.sourceChannelId}\u0000${b.targetChannelId}`;
      return aKey.localeCompare(bKey);
    });

  return {
    id: connection.id,
    sourceNodeId: connection.source.nodeId,
    targetNodeId: connection.target.nodeId,
    bindings,
  };
}

function externalNodes(graph: HnapGraph): HexCell[] {
  return graph.nodes.filter(
    (node) => node.kind === "model" || node.kind === "tool",
  );
}

export function compileGraph(
  graph: HnapGraph,
  seed: number,
  policy: RuntimePolicy,
): CompileResult {
  const errors: CompileError[] = [];
  const validation = validateGraph(graph);

  for (const issue of validation.issues) {
    errors.push({
      code: "GRAPH_INVALID",
      message: `${issue.code}: ${issue.message}`,
      path: issue.path,
    });
  }

  const externals = externalNodes(graph);
  const allowedPermissions = new Set(policy.allowedPermissions);

  for (const node of externals) {
    const permission = permissionOf(node);

    if (permission === null) {
      errors.push({
        code: "PERMISSION_REQUIRED",
        message: `External node ${node.id} requires an explicit config.permission.`,
        path: `nodes.${node.id}.config.permission`,
      });
      continue;
    }

    if (!allowedPermissions.has(permission)) {
      errors.push({
        code: "PERMISSION_DENIED",
        message: `Permission ${permission} for node ${node.id} is not allowed by runtime policy.`,
        path: `nodes.${node.id}.config.permission`,
      });
    }
  }

  if (externals.length > 0 && graph.resourceBudget.maxExternalCalls < 1) {
    errors.push({
      code: "EXTERNAL_CALL_BUDGET_ZERO",
      message:
        "Graph contains model/tool nodes but maxExternalCalls is zero.",
      path: "resourceBudget.maxExternalCalls",
    });
  }

  if (externals.length > 0 && graph.resourceBudget.maxCostUnits === null) {
    errors.push({
      code: "UNBOUNDED_COST",
      message:
        "Graph contains model/tool nodes but maxCostUnits is unbounded.",
      path: "resourceBudget.maxCostUnits",
    });
  }

  const entries = graph.nodes
    .filter((node) => node.kind === "input")
    .map((node) => node.id)
    .sort();
  const outputs = graph.nodes
    .filter((node) => node.kind === "output")
    .map((node) => node.id)
    .sort();

  if (entries.length === 0) {
    errors.push({
      code: "NO_ENTRY_NODE",
      message: "Executable graph requires at least one input node.",
    });
  }

  if (outputs.length === 0) {
    errors.push({
      code: "NO_OUTPUT_NODE",
      message: "Executable graph requires at least one output node.",
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const nodes = [...graph.nodes].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const edges = graph.connections
    .filter((connection) => connection.enabled)
    .map((connection) => compileEdge(graph, connection))
    .sort((a, b) => a.id.localeCompare(b.id));

  const executable: ExecutableGraph = {
    graphId: graph.id,
    graphVersion: graph.version,
    seed: seed >>> 0,
    nodes,
    edges,
    entryNodeIds: entries,
    outputNodeIds: outputs,
    budget: { ...graph.resourceBudget },
    policy: {
      allowedPermissions: [...policy.allowedPermissions].sort(),
    },
  };

  return { ok: true, executable };
}
