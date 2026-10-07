import { neighbor } from "./geometry.js";
import type {
  Cluster,
  Face,
  FaceIndex,
  HexCell,
  MacroFace,
  SemanticChannel,
} from "./types.js";

function coordinateKey(q: number, r: number): string {
  return `${q}:${r}`;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();

  for (const item of items) {
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function sortedUnique(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

export function deriveMacroFaces(
  cells: HexCell[],
): [MacroFace, MacroFace, MacroFace, MacroFace, MacroFace, MacroFace] {
  const sortedCells = [...cells].sort((a, b) => a.id.localeCompare(b.id));
  const occupied = new Set(
    sortedCells.map((cell) =>
      coordinateKey(cell.coordinate.q, cell.coordinate.r),
    ),
  );

  const faces = [0, 1, 2, 3, 4, 5].map((index) => {
    const faceIndex = index as FaceIndex;
    const exposedChildFaces: MacroFace["exposedChildFaces"] = [];
    const semanticChannels: SemanticChannel[] = [];
    const projectionPopulation: string[] = [];

    for (const cell of sortedCells) {
      const adjacent = neighbor(cell.coordinate, faceIndex);
      const isBoundary = !occupied.has(
        coordinateKey(adjacent.q, adjacent.r),
      );

      if (!isBoundary) {
        continue;
      }

      const face = cell.faces[faceIndex];
      exposedChildFaces.push({ nodeId: cell.id, faceIndex });
      semanticChannels.push(...face.semanticChannels);
      projectionPopulation.push(...face.projectionPopulation);
    }

    exposedChildFaces.sort((a, b) => {
      const nodeOrder = a.nodeId.localeCompare(b.nodeId);
      return nodeOrder !== 0 ? nodeOrder : a.faceIndex - b.faceIndex;
    });

    return {
      index: faceIndex,
      exposedChildFaces,
      semanticChannels: uniqueById(semanticChannels),
      projectionPopulation: sortedUnique(projectionPopulation),
    };
  });

  return faces as [
    MacroFace,
    MacroFace,
    MacroFace,
    MacroFace,
    MacroFace,
    MacroFace,
  ];
}

export interface CompiledCluster {
  cluster: Cluster;
  node: HexCell;
}

export interface CompileClusterOptions {
  childConnectionIds?: string[];
  summarizedStateRef?: string | null;
}

function faceFromMacroFace(base: Face, macroFace: MacroFace): Face {
  return {
    ...base,
    semanticChannels: macroFace.semanticChannels.map((channel) => ({
      ...channel,
    })),
    projectionPopulation: [...macroFace.projectionPopulation],
    acceptedSchemas: sortedUnique(
      macroFace.semanticChannels.map((channel) => channel.schema),
    ),
    connectionIds: [...base.connectionIds].sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}

export function compileCluster(
  clusterNode: HexCell,
  children: HexCell[],
  options: CompileClusterOptions = {},
): CompiledCluster {
  if (clusterNode.kind !== "cluster") {
    throw new Error(
      `Cluster compiler expected node ${clusterNode.id} to have kind=cluster.`,
    );
  }

  const wrongParent = children.find(
    (child) => child.parentId !== clusterNode.id,
  );

  if (wrongParent) {
    throw new Error(
      `Child ${wrongParent.id} does not belong to cluster ${clusterNode.id}.`,
    );
  }

  const macroFaces = deriveMacroFaces(children);
  const faces = macroFaces.map((macroFace) =>
    faceFromMacroFace(clusterNode.faces[macroFace.index], macroFace),
  ) as HexCell["faces"];

  const childNodeIds = children
    .map((child) => child.id)
    .sort((a, b) => a.localeCompare(b));

  return {
    cluster: {
      id: clusterNode.id,
      childNodeIds,
      childConnectionIds: [...(options.childConnectionIds ?? [])].sort(
        (a, b) => a.localeCompare(b),
      ),
      macroFaces,
      summarizedStateRef: options.summarizedStateRef ?? null,
    },
    node: {
      ...clusterNode,
      faces,
    },
  };
}
