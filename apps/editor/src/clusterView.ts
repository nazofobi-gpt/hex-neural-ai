import { AXIAL_DIRECTIONS } from "../../../packages/protocol/src/index.js";
import type { EditorHex } from "./editorState";

export interface EditorViewConnection {
  id: string;
  sourceId: string;
  targetId: string;
}

export interface EditorViewCluster {
  id: string;
  label: string;
  q: number;
  r: number;
  parentClusterId: string | null;
  childNodeIds: string[];
  childClusterIds: string[];
}

export interface ClusterViewGraph {
  nodes: EditorHex[];
  connections: EditorViewConnection[];
  clusters: EditorViewCluster[];
}

export interface ResolvedClusterNode extends EditorHex {
  kind: "hex" | "cluster";
}

export type ClusterCollapseLevel = 0 | 1 | 2;

export interface ResolvedClusterView {
  nodes: ResolvedClusterNode[];
  connections: EditorViewConnection[];
  collapseLevel: ClusterCollapseLevel;
  semanticCollapseLevel: ClusterCollapseLevel;
  manualCollapseLevel: ClusterCollapseLevel;
  rootClusterIds: string[];
  identityFingerprint: string;
}

function clampLevel(value: number): ClusterCollapseLevel {
  return Math.max(0, Math.min(2, value)) as ClusterCollapseLevel;
}

export function semanticCollapseLevel(
  scale: number,
): ClusterCollapseLevel {
  if (scale < 0.45) {
    return 2;
  }

  if (scale < 0.75) {
    return 1;
  }

  return 0;
}

function sorted<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

export function clusterGraphIdentity(
  graph: ClusterViewGraph,
): string {
  return JSON.stringify({
    nodes: sorted(graph.nodes).map((node) => ({
      id: node.id,
      label: node.label,
      q: node.q,
      r: node.r,
    })),
    connections: sorted(graph.connections).map((connection) => ({
      id: connection.id,
      sourceId: connection.sourceId,
      targetId: connection.targetId,
    })),
    clusters: sorted(graph.clusters).map((cluster) => ({
      id: cluster.id,
      label: cluster.label,
      q: cluster.q,
      r: cluster.r,
      parentClusterId: cluster.parentClusterId,
      childNodeIds: [...cluster.childNodeIds].sort(),
      childClusterIds: [...cluster.childClusterIds].sort(),
    })),
  });
}

function descendants(
  cluster: EditorViewCluster,
  clusterById: Map<string, EditorViewCluster>,
): { nodeIds: string[]; clusterIds: string[] } {
  const nodeIds = [...cluster.childNodeIds];
  const clusterIds: string[] = [];

  for (const childClusterId of cluster.childClusterIds) {
    const child = clusterById.get(childClusterId);
    if (!child) {
      continue;
    }

    clusterIds.push(child.id);
    const nested = descendants(child, clusterById);
    nodeIds.push(...nested.nodeIds);
    clusterIds.push(...nested.clusterIds);
  }

  return { nodeIds, clusterIds };
}

export function resolveClusterView(
  graph: ClusterViewGraph,
  scale: number,
  manualCollapseLevel: ClusterCollapseLevel = 0,
): ResolvedClusterView {
  const semanticLevel = semanticCollapseLevel(scale);
  const collapseLevel = clampLevel(
    Math.max(semanticLevel, manualCollapseLevel),
  );
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const clusterById = new Map(
    graph.clusters.map((cluster) => [cluster.id, cluster]),
  );
  const roots = sorted(
    graph.clusters.filter(
      (cluster) => cluster.parentClusterId === null,
    ),
  );
  const represented = new Map<string, string>();
  const visible: ResolvedClusterNode[] = [];

  function addNode(nodeId: string): void {
    const node = nodeById.get(nodeId);
    if (!node) {
      return;
    }

    visible.push({ ...node, kind: "hex" });
    represented.set(node.id, node.id);
  }

  function addCollapsedCluster(cluster: EditorViewCluster): void {
    visible.push({
      id: cluster.id,
      label: cluster.label,
      q: cluster.q,
      r: cluster.r,
      kind: "cluster",
    });

    const nested = descendants(cluster, clusterById);
    for (const nodeId of nested.nodeIds) {
      represented.set(nodeId, cluster.id);
    }
    for (const clusterId of [cluster.id, ...nested.clusterIds]) {
      represented.set(clusterId, cluster.id);
    }
  }

  function visitCluster(
    cluster: EditorViewCluster,
    depth: number,
  ): void {
    const collapse =
      collapseLevel === 2
        ? depth === 0
        : collapseLevel === 1
          ? depth >= 1
          : false;

    if (collapse) {
      addCollapsedCluster(cluster);
      return;
    }

    for (const nodeId of [...cluster.childNodeIds].sort()) {
      addNode(nodeId);
    }

    for (const childClusterId of [...cluster.childClusterIds].sort()) {
      const child = clusterById.get(childClusterId);
      if (child) {
        visitCluster(child, depth + 1);
      }
    }
  }

  const clusteredNodeIds = new Set<string>();
  for (const root of roots) {
    const nested = descendants(root, clusterById);
    nested.nodeIds.forEach((id) => clusteredNodeIds.add(id));
    visitCluster(root, 0);
  }

  for (const node of sorted(graph.nodes)) {
    if (!clusteredNodeIds.has(node.id)) {
      visible.push({ ...node, kind: "hex" });
      represented.set(node.id, node.id);
    }
  }

  const connectionKeys = new Set<string>();
  const connections: EditorViewConnection[] = [];

  for (const connection of sorted(graph.connections)) {
    const sourceId =
      represented.get(connection.sourceId) ?? connection.sourceId;
    const targetId =
      represented.get(connection.targetId) ?? connection.targetId;

    if (sourceId === targetId) {
      continue;
    }

    const key = `${sourceId}\u0000${targetId}`;
    if (connectionKeys.has(key)) {
      continue;
    }

    connectionKeys.add(key);
    connections.push({
      id: connection.id,
      sourceId,
      targetId,
    });
  }

  return {
    nodes: sorted(visible),
    connections,
    collapseLevel,
    semanticCollapseLevel: semanticLevel,
    manualCollapseLevel,
    rootClusterIds: roots.map((cluster) => cluster.id),
    identityFingerprint: clusterGraphIdentity(graph),
  };
}

export class ClusterExpansionHistory {
  private levelValue: ClusterCollapseLevel = 0;
  private past: ClusterCollapseLevel[] = [];
  private future: ClusterCollapseLevel[] = [];
  private revisionValue = 0;

  public get level(): ClusterCollapseLevel {
    return this.levelValue;
  }

  public get revision(): number {
    return this.revisionValue;
  }

  public collapse(): boolean {
    if (this.levelValue >= 2) {
      return false;
    }

    this.checkpoint();
    this.levelValue = clampLevel(this.levelValue + 1);
    this.revisionValue += 1;
    return true;
  }

  public expand(): boolean {
    if (this.levelValue <= 0) {
      return false;
    }

    this.checkpoint();
    this.levelValue = clampLevel(this.levelValue - 1);
    this.revisionValue += 1;
    return true;
  }

  public undo(): boolean {
    const previous = this.past.pop();
    if (previous === undefined) {
      return false;
    }

    this.future.push(this.levelValue);
    this.levelValue = previous;
    this.revisionValue += 1;
    return true;
  }

  public redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) {
      return false;
    }

    this.past.push(this.levelValue);
    this.levelValue = next;
    this.revisionValue += 1;
    return true;
  }

  private checkpoint(): void {
    this.past.push(this.levelValue);
    this.future = [];
  }
}

export function createClusterDemoGraph(): ClusterViewGraph {
  const innerNodes: EditorHex[] = [
    { id: "inner-center", label: "Inner Center", q: 0, r: 0 },
    ...AXIAL_DIRECTIONS.map((direction, index) => ({
      id: `inner-${index}`,
      label: `Inner ${index}`,
      q: direction.q,
      r: direction.r,
    })),
  ];

  const outerNodes: EditorHex[] = AXIAL_DIRECTIONS.map(
    (direction, index) => ({
      id: `outer-${index}`,
      label: `Outer ${index}`,
      q: direction.q * 3,
      r: direction.r * 3,
    }),
  );

  const innerConnections: EditorViewConnection[] =
    AXIAL_DIRECTIONS.map((_, index) => ({
      id: `inner-link-${index}`,
      sourceId: "inner-center",
      targetId: `inner-${index}`,
    }));

  const outerConnections: EditorViewConnection[] =
    AXIAL_DIRECTIONS.map((_, index) => ({
      id: `outer-link-${index}`,
      sourceId: `outer-${index}`,
      targetId: `inner-${index}`,
    }));

  return {
    nodes: [...innerNodes, ...outerNodes],
    connections: [...innerConnections, ...outerConnections],
    clusters: [
      {
        id: "cluster-root",
        label: "Application Cluster",
        q: 0,
        r: 0,
        parentClusterId: null,
        childNodeIds: outerNodes.map((node) => node.id),
        childClusterIds: ["cluster-inner"],
      },
      {
        id: "cluster-inner",
        label: "Nested Cluster",
        q: 0,
        r: 0,
        parentClusterId: "cluster-root",
        childNodeIds: innerNodes.map((node) => node.id),
        childClusterIds: [],
      },
    ],
  };
}
