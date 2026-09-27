import { useEffect, useRef, useState } from "react";
import {
  Application,
  Container,
  FederatedPointerEvent,
  Graphics,
  Point,
  Text,
  TextStyle,
} from "pixi.js";
import {
  OPPOSITE_FACE,
  type AxialCoordinate,
} from "../../../packages/protocol/src/index.js";
import { EditorState, createInitialHexes, type EditorHex } from "./editorState";
import {
  axialToPixel,
  faceBetween,
  hexPolygonPoints,
  pixelToAxial,
} from "./hexMath";

const HEX_SIZE = 42;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.5;

interface CanvasActions {
  add: () => void;
  remove: () => void;
  undo: () => void;
  redo: () => void;
}

export function HexCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<CanvasActions | null>(null);
  const [status, setStatus] = useState("Ready · 37 hexes");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

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
      "Interactive hex canvas. Drag hexes, drag empty canvas to pan, and use the mouse wheel to zoom.",
    );
    host.appendChild(canvas);

    const viewport = new Container();
    viewport.position.set(host.clientWidth / 2, host.clientHeight / 2);
    app.stage.addChild(viewport);
    app.stage.eventMode = "static";
    app.stage.hitArea = app.screen;

    const editor = new EditorState(createInitialHexes(3));
    let selectedId: string | null = null;
    let draggingId: string | null = null;
    let panning = false;
    let lastPointer = new Point();

    const textStyle = new TextStyle({
      fill: 0xdbeafe,
      fontFamily: "system-ui, sans-serif",
      fontSize: 11,
      fontWeight: "600",
    });

    function nodeAt(id: string): EditorHex | undefined {
      return editor.nodes.find((node) => node.id === id);
    }

    function updateStatus(prefix = "Ready"): void {
      const selected = selectedId ? nodeAt(selectedId) : undefined;
      const suffix = selected
        ? ` · ${selected.label} [q=${selected.q}, r=${selected.r}]`
        : "";
      setStatus(`${prefix} · ${editor.nodes.length} hexes${suffix}`);
    }

    function drawConnectionPreview(node: EditorHex): void {
      for (const candidate of editor.nodes) {
        if (candidate.id === node.id) {
          continue;
        }

        const face = faceBetween(node, candidate);
        if (face === null) {
          continue;
        }

        const start = axialToPixel(node, HEX_SIZE);
        const end = axialToPixel(candidate, HEX_SIZE);
        const edge = new Graphics();
        edge.lineStyle(4, 0x22d3ee, 0.9);
        edge.moveTo(start.x, start.y);
        edge.lineTo(end.x, end.y);
        viewport.addChild(edge);

        const badge = new Text(
          `${face}↔${OPPOSITE_FACE[face]}`,
          new TextStyle({
            fill: 0x67e8f9,
            fontFamily: "ui-monospace, monospace",
            fontSize: 9,
          }),
        );
        badge.anchor.set(0.5);
        badge.position.set((start.x + end.x) / 2, (start.y + end.y) / 2);
        viewport.addChild(badge);
      }
    }

    function render(): void {
      viewport.removeChildren().forEach((child) => child.destroy());

      for (const node of editor.nodes) {
        const position = axialToPixel(node, HEX_SIZE);
        const selected = node.id === selectedId;
        const hex = new Graphics();
        hex.lineStyle(selected ? 4 : 2, selected ? 0x67e8f9 : 0x475569, 1);
        hex.beginFill(selected ? 0x164e63 : 0x172033, 0.96);
        hex.drawPolygon(hexPolygonPoints(HEX_SIZE - 2));
        hex.endFill();
        hex.position.set(position.x, position.y);
        hex.eventMode = "static";
        hex.cursor = "grab";

        hex.on("pointerdown", (event: FederatedPointerEvent) => {
          event.stopPropagation();
          selectedId = node.id;
          draggingId = node.id;
          hex.cursor = "grabbing";
          render();
          updateStatus("Selected");
        });

        viewport.addChild(hex);

        const label = new Text(`${node.q},${node.r}`, textStyle);
        label.anchor.set(0.5);
        label.position.set(position.x, position.y);
        label.eventMode = "none";
        viewport.addChild(label);
      }

      const selected = selectedId ? nodeAt(selectedId) : undefined;
      if (selected) {
        drawConnectionPreview(selected);
      }
    }

    app.stage.on("pointerdown", (event: FederatedPointerEvent) => {
      panning = true;
      lastPointer.copyFrom(event.global);
      selectedId = null;
      render();
      updateStatus("Panning");
    });

    app.stage.on("pointermove", (event: FederatedPointerEvent) => {
      if (draggingId) {
        const local = viewport.toLocal(event.global);
        const target = pixelToAxial(local, HEX_SIZE);
        if (editor.move(draggingId, target)) {
          render();
          updateStatus("Snapped");
        }
        return;
      }

      if (panning) {
        viewport.position.x += event.global.x - lastPointer.x;
        viewport.position.y += event.global.y - lastPointer.y;
        lastPointer.copyFrom(event.global);
      }
    });

    const finishPointer = () => {
      draggingId = null;
      panning = false;
      updateStatus("Ready");
    };

    app.stage.on("pointerup", finishPointer);
    app.stage.on("pointerupoutside", finishPointer);

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
      updateStatus(`Zoom ${Math.round(nextScale * 100)}%`);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey ? editor.redo() : editor.undo()) {
          render();
          updateStatus(event.shiftKey ? "Redo" : "Undo");
        }
      } else if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        if (editor.redo()) {
          render();
          updateStatus("Redo");
        }
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        event.preventDefault();
        editor.remove(selectedId);
        selectedId = null;
        render();
        updateStatus("Deleted");
      }
    };
    canvas.addEventListener("keydown", onKeyDown);

    actionsRef.current = {
      add: () => {
        const added = editor.addAt(editor.firstEmptyCoordinate());
        if (added) {
          selectedId = added.id;
          render();
          updateStatus("Added");
        }
      },
      remove: () => {
        if (selectedId && editor.remove(selectedId)) {
          selectedId = null;
          render();
          updateStatus("Deleted");
        }
      },
      undo: () => {
        if (editor.undo()) {
          render();
          updateStatus("Undo");
        }
      },
      redo: () => {
        if (editor.redo()) {
          render();
          updateStatus("Redo");
        }
      },
    };

    render();
    updateStatus();

    return () => {
      actionsRef.current = null;
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKeyDown);
      app.destroy(true, {
        children: true,
        texture: true,
        baseTexture: true,
      });
    };
  }, []);

  return (
    <section className="editor-panel" aria-label="Hex editor">
      <div className="toolbar" role="toolbar" aria-label="Hex editor controls">
        <button type="button" onClick={() => actionsRef.current?.add()}>
          Add hex
        </button>
        <button type="button" onClick={() => actionsRef.current?.remove()}>
          Delete selected
        </button>
        <button type="button" onClick={() => actionsRef.current?.undo()}>
          Undo
        </button>
        <button type="button" onClick={() => actionsRef.current?.redo()}>
          Redo
        </button>
        <span className="status" aria-live="polite">
          {status}
        </span>
      </div>
      <div ref={hostRef} className="canvas-host" />
      <footer className="hint">
        Drag a hex to snap · drag empty space to pan · wheel to zoom · Ctrl/Cmd+Z
        to undo
      </footer>
    </section>
  );
}
