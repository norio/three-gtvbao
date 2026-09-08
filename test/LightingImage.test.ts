import { describe, expect, it } from "vitest";
import { compareLightingImage } from "./webgpu/lighting-image.js";

const image = (value: number) => Float32Array.from({ length: 10 * 10 * 4 }, (_, i) => i % 4 === 3 ? 1 : value);

describe("example lighting image regression", () => {
  it("accepts neutral AO and normal local darkening", () => {
    expect(compareLightingImage(image(1), image(1), 10, 10, true).passed).toBe(true);
    expect(compareLightingImage(image(0.8), image(1), 10, 10, false).passed).toBe(true);
  });

  it("rejects finite black geometry even when the outer background is unchanged", () => {
    const actual = image(1);
    for (let y = 1; y < 9; y++) {
      for (let x = 1; x < 9; x++) actual.fill(0, (y * 10 + x) * 4, (y * 10 + x) * 4 + 3);
    }
    const metrics = compareLightingImage(actual, image(1), 10, 10, false);
    expect(metrics.passed).toBe(false);
    expect(metrics.severeDarkeningFraction).toBe(1);
  });

  it("rejects an AO-off identity error that the broad blackening guard accepts", () => {
    expect(compareLightingImage(image(0.99), image(1), 10, 10, false).passed).toBe(true);
    expect(compareLightingImage(image(0.99), image(1), 10, 10, true).passed).toBe(false);
  });

  it.each([0.25, 1, 4])("accepts one isolated half-float step at magnitude %s", value => {
    const actual = image(value);
    actual[(2 * 10 + 2) * 4] += value * 2 ** -10;
    const metrics = compareLightingImage(actual, image(value), 10, 10, true);
    expect(metrics.maxHalfFloatUlps).toBe(1);
    expect(metrics.passed).toBe(true);
  });

  it("rejects two half-float steps on either side of a power-of-two boundary", () => {
    for (const delta of [2 ** -11, 2 ** -10, -(2 ** -11), -(2 ** -10)]) {
      const actual = image(1);
      actual[(2 * 10 + 2) * 4] += delta;
      const expectedUlps = delta < 0 ? -delta / 2 ** -11 : delta / 2 ** -10;
      const metrics = compareLightingImage(actual, image(1), 10, 10, true);
      expect(metrics.maxHalfFloatUlps).toBe(expectedUlps);
      expect(metrics.passed).toBe(expectedUlps <= 1);
    }
    const actual = image(1);
    actual[(2 * 10 + 2) * 4] += 2 ** -9;
    expect(compareLightingImage(actual, image(1), 10, 10, true).passed).toBe(false);
  });

  it("rejects systematic darkening even when every channel is within one half-float step", () => {
    const metrics = compareLightingImage(image(1 - 2 ** -11), image(1), 10, 10, true);
    expect(metrics.maxHalfFloatUlps).toBe(1);
    expect(metrics.passed).toBe(false);
  });

  it("rejects nonfinite or uninformative reference images", () => {
    expect(compareLightingImage(image(NaN), image(1), 10, 10, false).passed).toBe(false);
    expect(compareLightingImage(image(0), image(0), 10, 10, true).passed).toBe(false);
  });
});
