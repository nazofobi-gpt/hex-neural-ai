import type { AxialCoordinate, FaceIndex } from "./types.js";

export const AXIAL_DIRECTIONS: ReadonlyArray<Readonly<AxialCoordinate>> = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
] as const;

export const OPPOSITE_FACE: Readonly<Record<FaceIndex, FaceIndex>> = {
  0: 3,
  1: 4,
  2: 5,
  3: 0,
  4: 1,
  5: 2,
};

export function neighbor(
  coordinate: AxialCoordinate,
  faceIndex: FaceIndex,
): AxialCoordinate {
  const direction = AXIAL_DIRECTIONS[faceIndex];

  if (!direction) {
    throw new Error(`Invalid face index: ${faceIndex}`);
  }

  return {
    q: coordinate.q + direction.q,
    r: coordinate.r + direction.r,
  };
}

export function isSameCoordinate(
  a: AxialCoordinate,
  b: AxialCoordinate,
): boolean {
  return a.q === b.q && a.r === b.r;
}

export function isAdjacentOnFaces(
  source: AxialCoordinate,
  sourceFace: FaceIndex,
  target: AxialCoordinate,
  targetFace: FaceIndex,
): boolean {
  return (
    OPPOSITE_FACE[sourceFace] === targetFace &&
    isSameCoordinate(neighbor(source, sourceFace), target)
  );
}