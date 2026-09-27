import { neighbor } from "./geometry.js";
import type { FaceIndex, HexCell, MacroFace, SemanticChannel } from "./types.js";

function coordinateKey(q: number, r: number): string {
  return `${q}:${r}`;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }

  return result;
}

export function deriveMacroFaces(
  cells: HexCell[],
): [MacroFace, MacroFace, MacroFace, MacroFace, MacroFace, MacroFace] {
  const occupied = new Set(
    cells.map((cell) => coordinateKey(cell.coordinate.q, cell.coordinate.r)),
  );

  const faces = [0, 1, 2, 3, 4, 5].map((index) => {
    const faceIndex = index as FaceIndex;
    const exposedChildFaces: MacroFace["exposedChildFaces"] = [];
    const semanticChannels: SemanticChannel[] = [];
    const projectionPopulation: string[] = [];

    for (const cell of cells) {
      const adjacent = neighbor(cell.coordinate, faceIndex);
      const isBoundary = !occupied.has(coordinateKey(adjacent.q, adjacent.r));

      if (!isBoundary) {
        continue;
      }

      const face = cell.faces[faceIndex];
      exposedChildFaces.push({ nodeId: cell.id, faceIndex });
      semanticChannels.push(...face.semanticChannels);
      projectionPopulation.push(...face.projectionPopulation);
    }

    return {
      index: faceIndex,
      exposedChildFaces,
      semanticChannels: uniqueById(semanticChannels),
      projectionPopulation: [...new Set(projectionPopulation)],
    };
  });

  return faces as [MacroFace, MacroFace, MacroFace, MacroFace, MacroFace, MacroFace];
}
