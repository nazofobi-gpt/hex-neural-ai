import { describe, expect, it } from "vitest";
import {
  ClusterExpansionHistory,
  clusterGraphIdentity,
  createClusterDemoGraph,
  resolveClusterView,
  semanticCollapseLevel,
} from "../src/clusterView";

describe("cluster semantic view", () => {
  it("switches detail -> nested -> root abstraction without identity drift", () => {
    const graph = createClusterDemoGraph();
    const identity = clusterGraphIdentity(graph);

    const detail = resolveClusterView(graph, 1, 0);
    expect(detail.collapseLevel).toBe(0);
    expect(detail.nodes).toHaveLength(13);
    expect(detail.identityFingerprint).toBe(identity);

    const nested = resolveClusterView(graph, 0.6, 0);
    expect(nested.collapseLevel).toBe(1);
    expect(nested.nodes.map((node) => node.id)).toContain("cluster-inner");
    expect(nested.nodes).toHaveLength(7);
    expect(nested.identityFingerprint).toBe(identity);

    const overview = resolveClusterView(graph, 0.35, 0);
    expect(overview.collapseLevel).toBe(2);
    expect(overview.nodes).toEqual([
      expect.objectContaining({
        id: "cluster-root",
        kind: "cluster",
      }),
    ]);
    expect(overview.identityFingerprint).toBe(identity);
  });

  it("collapse and expand are reversible view operations and preserve graph connections", () => {
    const graph = createClusterDemoGraph();
    const identity = clusterGraphIdentity(graph);
    const originalConnections = structuredClone(graph.connections);
    const history = new ClusterExpansionHistory();

    expect(history.collapse()).toBe(true);
    expect(history.level).toBe(1);
    expect(history.collapse()).toBe(true);
    expect(history.level).toBe(2);

    const collapsed = resolveClusterView(graph, 1, history.level);
    expect(collapsed.nodes).toHaveLength(1);
    expect(clusterGraphIdentity(graph)).toBe(identity);
    expect(graph.connections).toEqual(originalConnections);

    expect(history.undo()).toBe(true);
    expect(history.level).toBe(1);
    expect(history.undo()).toBe(true);
    expect(history.level).toBe(0);

    const restored = resolveClusterView(graph, 1, history.level);
    expect(restored.nodes).toHaveLength(13);
    expect(restored.identityFingerprint).toBe(identity);
    expect(graph.connections).toEqual(originalConnections);

    expect(history.redo()).toBe(true);
    expect(history.level).toBe(1);
    expect(history.revision).toBeGreaterThan(0);
  });

  it("semantic zoom thresholds are deterministic", () => {
    expect(semanticCollapseLevel(1)).toBe(0);
    expect(semanticCollapseLevel(0.75)).toBe(0);
    expect(semanticCollapseLevel(0.749)).toBe(1);
    expect(semanticCollapseLevel(0.45)).toBe(1);
    expect(semanticCollapseLevel(0.449)).toBe(2);
  });
});
