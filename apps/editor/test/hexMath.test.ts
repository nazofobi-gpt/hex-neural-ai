import { describe, expect, it } from "vitest";
import {
  axialToPixel,
  faceBetween,
  pixelToAxial,
  roundAxial,
} from "../src/hexMath";

describe("hexMath", () => {
  it("round-trips axial coordinates through pixel space", () => {
    const samples = [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: -3, r: 2 },
      { q: 8, r: -5 },
    ];

    for (const coordinate of samples) {
      expect(pixelToAxial(axialToPixel(coordinate, 42), 42)).toEqual(coordinate);
    }
  });

  it("rounds fractional cube coordinates deterministically", () => {
    expect(roundAxial(0.49, 0.49)).toEqual({ q: 0, r: 1 });
    expect(roundAxial(1.51, -0.51)).toEqual({ q: 2, r: -1 });
  });

  it("maps all six direct neighbors to their face index", () => {
    const source = { q: 0, r: 0 };
    const targets = [
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ];

    targets.forEach((target, index) => {
      expect(faceBetween(source, target)).toBe(index);
    });
    expect(faceBetween(source, { q: 2, r: 0 })).toBeNull();
  });
});
