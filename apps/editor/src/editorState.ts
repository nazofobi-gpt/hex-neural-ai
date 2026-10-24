import type { AxialCoordinate } from "../../../packages/protocol/src/index.js";
import { coordinateKey } from "./hexMath";
import type { VersionSnapshot } from "./versionStore";

export interface EditorHex extends AxialCoordinate {
  id: string;
  label: string;
}

interface Snapshot {
  nodes: EditorHex[];
  nextSequence: number;
}

function cloneNodes(nodes: EditorHex[]): EditorHex[] {
  return nodes.map((node) => ({ ...node }));
}

export class EditorState {
  private nodesValue: EditorHex[];
  private nextSequenceValue: number;
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];

  public constructor(nodes: EditorHex[]) {
    this.nodesValue = cloneNodes(nodes);
    this.nextSequenceValue = nodes.length + 1;
  }

  public get nodes(): readonly EditorHex[] {
    return this.nodesValue;
  }

  /** Detached graph state for a durable, project-scoped named checkpoint. */
  public exportVersionSnapshot(): VersionSnapshot {
    return this.snapshot();
  }

  /**
   * Apply a previously validated graph checkpoint to this editor only.
   * Never replays external tools. A successful restore invalidates transient
   * undo/redo stacks so an old edit cannot silently overwrite restored data.
   */
  public applyVersionSnapshot(snapshot: VersionSnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.nodes) || snapshot.nodes.length > 5000 ||
        !Number.isSafeInteger(snapshot.nextSequence) || snapshot.nextSequence < 1) {
      throw new Error("INVALID_VERSION_SNAPSHOT");
    }
    const ids = new Set<string>();
    const positions = new Set<string>();
    let largestGeneratedId = 0;
    const nodes: EditorHex[] = snapshot.nodes.map((node) => {
      if (!node || typeof node.id !== "string" || !node.id.trim() || node.id.length > 256 ||
          typeof node.label !== "string" || node.label.length > 512 ||
          !Number.isSafeInteger(node.q) || !Number.isSafeInteger(node.r)) {
        throw new Error("INVALID_VERSION_SNAPSHOT");
      }
      const position = coordinateKey(node);
      if (ids.has(node.id) || positions.has(position)) {
        throw new Error("INVALID_VERSION_SNAPSHOT");
      }
      ids.add(node.id);
      positions.add(position);
      const match = /^hex-(\d+)$/.exec(node.id);
      if (match) largestGeneratedId = Math.max(largestGeneratedId, Number(match[1]));
      return { id: node.id, label: node.label, q: node.q, r: node.r };
    });
    if (snapshot.nextSequence <= largestGeneratedId) {
      throw new Error("INVALID_VERSION_SNAPSHOT");
    }
    this.restore({ nodes, nextSequence: snapshot.nextSequence });
    this.past = [];
    this.future = [];
  }

  public addAt(coordinate: AxialCoordinate): EditorHex | null {
    if (this.isOccupied(coordinate)) {
      return null;
    }

    this.checkpoint();
    const node: EditorHex = {
      id: `hex-${this.nextSequenceValue}`,
      label: `Hex ${this.nextSequenceValue}`,
      ...coordinate,
    };
    this.nextSequenceValue += 1;
    this.nodesValue = [...this.nodesValue, node];
    return node;
  }

  public move(id: string, coordinate: AxialCoordinate): boolean {
    const current = this.nodesValue.find((node) => node.id === id);
    if (!current) {
      return false;
    }

    if (current.q === coordinate.q && current.r === coordinate.r) {
      return true;
    }

    if (this.isOccupied(coordinate, id)) {
      return false;
    }

    this.checkpoint();
    this.nodesValue = this.nodesValue.map((node) =>
      node.id === id ? { ...node, ...coordinate } : node,
    );
    return true;
  }

  public remove(id: string): boolean {
    if (!this.nodesValue.some((node) => node.id === id)) {
      return false;
    }

    this.checkpoint();
    this.nodesValue = this.nodesValue.filter((node) => node.id !== id);
    return true;
  }

  public undo(): boolean {
    const previous = this.past.pop();
    if (!previous) {
      return false;
    }

    this.future.push(this.snapshot());
    this.restore(previous);
    return true;
  }

  public redo(): boolean {
    const next = this.future.pop();
    if (!next) {
      return false;
    }

    this.past.push(this.snapshot());
    this.restore(next);
    return true;
  }

  public firstEmptyCoordinate(radius = 8): AxialCoordinate {
    for (let r = -radius; r <= radius; r += 1) {
      for (let q = -radius; q <= radius; q += 1) {
        const coordinate = { q, r };
        if (!this.isOccupied(coordinate)) {
          return coordinate;
        }
      }
    }

    return { q: radius + 1, r: 0 };
  }

  private isOccupied(coordinate: AxialCoordinate, exceptId?: string): boolean {
    const key = coordinateKey(coordinate);
    return this.nodesValue.some(
      (node) => node.id !== exceptId && coordinateKey(node) === key,
    );
  }

  private checkpoint(): void {
    this.past.push(this.snapshot());
    this.future = [];
  }

  private snapshot(): Snapshot {
    return {
      nodes: cloneNodes(this.nodesValue),
      nextSequence: this.nextSequenceValue,
    };
  }

  private restore(snapshot: Snapshot): void {
    this.nodesValue = cloneNodes(snapshot.nodes);
    this.nextSequenceValue = snapshot.nextSequence;
  }
}

export function createInitialHexes(radius = 3): EditorHex[] {
  const nodes: EditorHex[] = [];
  let sequence = 1;

  for (let q = -radius; q <= radius; q += 1) {
    const rMin = Math.max(-radius, -q - radius);
    const rMax = Math.min(radius, -q + radius);

    for (let r = rMin; r <= rMax; r += 1) {
      nodes.push({
        id: `hex-${sequence}`,
        label: `Hex ${sequence}`,
        q,
        r,
      });
      sequence += 1;
    }
  }

  return nodes;
}
