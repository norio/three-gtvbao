import * as THREE from "three/webgpu";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

type ReadFloatTarget = typeof import("./webgpu/backend.js").readFloatTarget;
let readFloatTarget: ReadFloatTarget;

beforeAll(async () => {
  // backend.ts reads location.search at import and touches window/document on readback.
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { querySelector: () => null });
  ({ readFloatTarget } = await import("./webgpu/backend.js"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// Each channel encodes (row, column, channel) so a wrong stride or flip cannot match by accident.
const texel = (row: number, col: number, channel: number) => row * 1000 + col * 10 + channel;

/** Top-to-bottom, tightly packed RGBA32F expected from the function. */
function expectedPacked(width: number, height: number) {
  const out = new Float32Array(width * height * 4);
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++)
      for (let ch = 0; ch < 4; ch++) out[(r * width + c) * 4 + ch] = texel(r, c, ch);
  return out;
}

/** Source buffer with `stride` floats per row; `sourceRowOf(row)` picks which image row each source row holds. */
function buildSource(width: number, height: number, stride: number, length: number, sourceRowOf: (i: number) => number) {
  const src = new Float32Array(length).fill(-1);
  for (let i = 0; i < height; i++)
    for (let c = 0; c < width; c++)
      for (let ch = 0; ch < 4; ch++) src[i * stride + c * 4 + ch] = texel(sourceRowOf(i), c, ch);
  return src;
}

function read(coordinateSystem: number, width: number, height: number, pixels: Float32Array) {
  const renderer = {
    coordinateSystem,
    readRenderTargetPixelsAsync: async () => pixels,
  } as unknown as THREE.WebGPURenderer;
  return readFloatTarget(renderer, { width, height } as THREE.RenderTarget);
}

// 10 is not a multiple of 16 (so 256-byte padding is non-zero); 16 needs no padding.
describe.each([10, 16])("readFloatTarget width %i, height 3", (width) => {
  const height = 3;
  const expected = () => expectedPacked(width, height);

  test("WebGPU r184-r186: 256-byte padded rows", () => {
    const stride = Math.ceil((width * 16) / 256) * 64;
    const length = (height - 1) * stride + width * 4;
    const src = buildSource(width, height, stride, length, (i) => i);
    return expect(read(THREE.WebGPUCoordinateSystem, width, height, src)).resolves.toEqual(expected());
  });

  test("WebGPU r187: tightly packed rows", () => {
    const src = buildSource(width, height, width * 4, width * height * 4, (i) => i);
    return expect(read(THREE.WebGPUCoordinateSystem, width, height, src)).resolves.toEqual(expected());
  });

  test("WebGL: packed rows, bottom row first", () => {
    const src = buildSource(width, height, width * 4, width * height * 4, (i) => height - 1 - i);
    return expect(read(THREE.WebGLCoordinateSystem, width, height, src)).resolves.toEqual(expected());
  });
});
