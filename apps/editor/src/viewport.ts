import type { AxialCoordinate } from "../../../packages/protocol/src/index.js";
import { axialToPixel } from "./hexMath";

export interface ScreenSize {
  width: number;
  height: number;
}

export interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

export function calculateFitScale(
  nodes: readonly AxialCoordinate[],
  screen: ScreenSize,
  hexSize: number,
  padding = 64,
): number {
  if (nodes.length === 0) {
    return 1;
  }

  const positions = nodes.map((node) => axialToPixel(node, hexSize));
  const xs = positions.map((point) => point.x);
  const ys = positions.map((point) => point.y);

  const contentWidth = Math.max(...xs) - Math.min(...xs) + hexSize * 2;
  const contentHeight = Math.max(...ys) - Math.min(...ys) + hexSize * 2;
  const availableWidth = Math.max(1, screen.width - padding * 2);
  const availableHeight = Math.max(1, screen.height - padding * 2);

  return Math.min(
    1,
    availableWidth / Math.max(contentWidth, 1),
    availableHeight / Math.max(contentHeight, 1),
  );
}

export function isCoordinateVisible(
  coordinate: AxialCoordinate,
  hexSize: number,
  transform: ViewTransform,
  screen: ScreenSize,
  margin = hexSize * 2,
): boolean {
  const local = axialToPixel(coordinate, hexSize);
  const x = transform.x + local.x * transform.scale;
  const y = transform.y + local.y * transform.scale;
  const scaledMargin = margin * transform.scale;

  return (
    x >= -scaledMargin &&
    x <= screen.width + scaledMargin &&
    y >= -scaledMargin &&
    y <= screen.height + scaledMargin
  );
}

export function zoomBand(scale: number): "overview" | "node" {
  return scale < 0.65 ? "overview" : "node";
}
