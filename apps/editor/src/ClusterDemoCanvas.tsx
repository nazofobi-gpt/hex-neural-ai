import { useEffect, useRef, useState } from "react";
import {
  Application,
  Container,
  Graphics,
  Point,
  Text,
  TextStyle,
} from "pixi.js";
import {
  ClusterExpansionHistory,
  createClusterDemoGraph,
  resolveClusterView,
  type ClusterCollapseLevel,
  type ResolvedClusterView,
} from "./clusterView";
import { axialToPixel, hexPolygonPoints } from "./hexMath";

const HEX_SIZE = 36;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.8;

interface ClusterActions {
  collapse: () => void;
  expand: () => void;
  undo: () => void;
  redo: () => void;
}

interface ClusterMetrics {
  scale: number;
  visibleNodeIds: string[];
  visibleConnectionCount: number;
  collapseLevel: ClusterCollapseLevel;
  semanticCollapseLevel: ClusterCollapseLevel;
  manualCollapseLevel: ClusterCollapseLevel;
  revision: number;
  identityFingerprint: string;
}

declare global {
  interface Window {
    __HEX_CLUSTER_METRICS__?: ClusterMetrics;
  }
}

function levelLabel(level: ClusterCollapseLevel): string {
  if (level === 2) {
    return "application";
  }
  if (level === 1) {
    return "nested";
  }
  return "detail";
}

export function ClusterDemoCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<ClusterActions | null>(null);
  const [status, setStatus] = useState("Cluster detail");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const graph = createClusterDemoGraph();
    const history = new ClusterExpansionHistory();
    const app = new Application({
      resizeTo: host,
      antialias: true,
      backgroundColor: 0x0b1020,
      resolution: Math.min(window.devicePixelRatio, 2),
      autoDensity: true,
    });
    const canvas = app.view as HTMLCanvasElement;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      "aria-label",
      "Recursive cluster semantic zoom canvas",
    );
    host.appendChild(canvas);

    const viewport = new Container();
    viewport.position.set(host.clientWidth / 2, host.clientHeight / 2);
    app.stage.addChild(viewport);
    app.stage.eventMode = "static";
    app.stage.hitArea = app.screen;

    const nodeText = new TextStyle({
      fill: 0xdbeafe,
      fontFamily: "system-ui, sans-serif",
      fontSize: 11,
      fontWeight: "600",
      align: "center",
    });

    let lastView: ResolvedClusterView = resolveClusterView(
      graph,
      viewport.scale.x,
      history.level,
    );

    function updateStatus(): void {
      const label = levelLabel(lastView.collapseLevel);
      setStatus(
        `Cluster ${label} · ${lastView.nodes.length} visible · ${lastView.connections.length} links · view rev ${history.revision} · zoom ${Math.round(viewport.scale.x * 100)}%`,
      );
    }

    function publishMetrics(): void {
      window.__HEX_CLUSTER_METRICS__ = {
        scale: viewport.scale.x,
        visibleNodeIds: lastView.nodes.map((node) => node.id),
        visibleConnectionCount: lastView.connections.length,
        collapseLevel: lastView.collapseLevel,
        semanticCollapseLevel: lastView.semanticCollapseLevel,
        manualCollapseLevel: lastView.manualCollapseLevel,
        revision: history.revision,
        identityFingerprint: lastView.identityFingerprint,
      };
    }

    function render(): void {
      viewport.removeChildren().forEach((child) => child.destroy());
      lastView = resolveClusterView(
        graph,
        viewport.scale.x,
        history.level,
      );

      const nodeById = new Map(
        lastView.nodes.map((node) => [node.id, node]),
      );

      for (const connection of lastView.connections) {
        const source = nodeById.get(connection.sourceId);
        const target = nodeById.get(connection.targetId);
        if (!source || !target) {
          continue;
        }

        const start = axialToPixel(source, HEX_SIZE);
        const end = axialToPixel(target, HEX_SIZE);
        const edge = new Graphics();
        edge.lineStyle(2, 0x334155, 0.85);
        edge.moveTo(start.x, start.y);
        edge.lineTo(end.x, end.y);
        viewport.addChild(edge);
      }

      for (const node of lastView.nodes) {
        const position = axialToPixel(node, HEX_SIZE);
        const cluster = node.kind === "cluster";
        const radius = cluster ? HEX_SIZE * 1.35 : HEX_SIZE;
        const hex = new Graphics();
        hex.lineStyle(
          cluster ? 4 : 2,
          cluster ? 0x67e8f9 : 0x475569,
          1,
        );
        hex.beginFill(cluster ? 0x164e63 : 0x172033, 0.96);
        hex.drawPolygon(hexPolygonPoints(radius - 2));
        hex.endFill();
        hex.position.set(position.x, position.y);
        viewport.addChild(hex);

        if (viewport.scale.x >= 0.52 || cluster) {
          const label = new Text(node.label, nodeText);
          label.anchor.set(0.5);
          label.position.set(position.x, position.y);
          label.scale.set(cluster ? 0.95 : 0.82);
          viewport.addChild(label);
        }
      }

      publishMetrics();
      updateStatus();
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const global = new Point(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      const before = viewport.toLocal(global);
      const factor = event.deltaY < 0 ? 1.1 : 0.9;
      const nextScale = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, viewport.scale.x * factor),
      );

      viewport.scale.set(nextScale);
      const after = viewport.toGlobal(before);
      viewport.position.x += global.x - after.x;
      viewport.position.y += global.y - after.y;
      render();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    actionsRef.current = {
      collapse: () => {
        if (history.collapse()) {
          render();
        }
      },
      expand: () => {
        if (history.expand()) {
          render();
        }
      },
      undo: () => {
        if (history.undo()) {
          render();
        }
      },
      redo: () => {
        if (history.redo()) {
          render();
        }
      },
    };

    render();

    return () => {
      actionsRef.current = null;
      delete window.__HEX_CLUSTER_METRICS__;
      canvas.removeEventListener("wheel", onWheel);
      app.destroy(true, {
        children: true,
        texture: true,
        baseTexture: true,
      });
    };
  }, []);

  return (
    <section className="editor-panel" aria-label="Recursive cluster editor">
      <div
        className="toolbar"
        role="toolbar"
        aria-label="Recursive cluster controls"
      >
        <button
          type="button"
          onClick={() => actionsRef.current?.collapse()}
        >
          Collapse cluster
        </button>
        <button
          type="button"
          onClick={() => actionsRef.current?.expand()}
        >
          Expand cluster
        </button>
        <button type="button" onClick={() => actionsRef.current?.undo()}>
          Undo
        </button>
        <button type="button" onClick={() => actionsRef.current?.redo()}>
          Redo
        </button>
        <span className="status" role="status" aria-live="polite">
          {status}
        </span>
      </div>
      <div ref={hostRef} className="canvas-host" />
      <footer className="hint">
        Detail ≥75% · nested 45–74% · application &lt;45% · wheel zoom also
        changes abstraction automatically
      </footer>
    </section>
  );
}
