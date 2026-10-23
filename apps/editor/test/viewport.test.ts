import { describe, expect, it } from "vitest";
import { createInitialHexes } from "../src/editorState";
import {
  calculateFitScale,
  isCoordinateVisible,
  zoomBand,
} from "../src/viewport";

describe("viewport", () => {
  it("fits the 2k benchmark fixture below 1x zoom", () => {
    const nodes = createInitialHexes(26);
    expect(nodes).toHaveLength(2107);

    const scale = calculateFitScale(nodes, { width: 1440, height: 760 }, 42);
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1);
    expect(zoomBand(scale)).toBe("overview");
  });

  it("culls coordinates outside the transformed viewport", () => {
    const transform = { x: 500, y: 400, scale: 1 };
    const screen = { width: 1000, height: 800 };

    expect(
      isCoordinateVisible({ q: 0, r: 0 }, 42, transform, screen),
    ).toBe(true);
    expect(
      isCoordinateVisible({ q: 100, r: 100 }, 42, transform, screen),
    ).toBe(false);
  });
});
