import {
  AXIAL_DIRECTIONS,
  type AxialCoordinate,
  type FaceIndex,
} from "../../../packages/protocol/src/index.js";

export interface PixelPoint {
  x: number;
  y: number;
}

export function axialToPixel(
  coordinate: AxialCoordinate,
  size: number,
): PixelPoint {
  return {
    x: size * Math.sqrt(3) * (coordinate.q + coordinate.r / 2),
    y: size * 1.5 * coordinate.r,
  };
}

export function pixelToAxial(point: PixelPoint, size: number): AxialCoordinate {
  const q = ((Math.sqrt(3) / 3) * point.x - point.y / 3) / size;
  const r = ((2 / 3) * point.y) / size;
  return roundAxial(q, r);
}

export function roundAxial(q: number, r: number): AxialCoordinate {
  const x = q;
  const z = r;
  const y = -x - z;

  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return { q: rx, r: rz };
}

export function hexPolygonPoints(size: number): number[] {
  const points: number[] = [];

  for (let index = 0; index < 6; index += 1) {
    const angle = ((60 * index - 30) * Math.PI) / 180;
    points.push(size * Math.cos(angle), size * Math.sin(angle));
  }

  return points;
}

export function faceBetween(
  source: AxialCoordinate,
  target: AxialCoordinate,
): FaceIndex | null {
  for (let index = 0; index < AXIAL_DIRECTIONS.length; index += 1) {
    const direction = AXIAL_DIRECTIONS[index]!;
    if (
      source.q + direction.q === target.q &&
      source.r + direction.r === target.r
    ) {
      return index as FaceIndex;
    }
  }

  return null;
}

export function coordinateKey(coordinate: AxialCoordinate): string {
  return `${coordinate.q}:${coordinate.r}`;
}
