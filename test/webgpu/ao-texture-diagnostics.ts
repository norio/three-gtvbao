import type { Texture, WebGPURenderer } from "three/webgpu";
import { screenUV, texture } from "three/tsl";
import { renderProbe } from "./backend.js";

// Read the allocated texture without its PassTextureNode dependencies. In
// particular, observing a skipped denoiser must not execute it for this frame.
export async function inspectAoTexture(renderer: WebGPURenderer, source: Texture) {
  const { width, height } = source.image as { width: number; height: number };
  const pixels = await renderProbe(renderer, texture(source).sample(screenUV), width, height);
  let min = Infinity;
  let max = -Infinity;
  let nonfiniteTexels = 0;
  let belowNeutralTexels = 0;
  const belowNeutralSamples: { x: number; y: number; value: number }[] = [];
  for (let i = 0; i < width * height; i++) {
    const value = pixels[i * 4];
    if (!Number.isFinite(value)) {
      nonfiniteTexels++;
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
    if (value < 0.999) {
      belowNeutralTexels++;
      if (belowNeutralSamples.length < 16) belowNeutralSamples.push({ x: i % width, y: Math.floor(i / width), value });
    }
  }
  // Neutral AO is exactly representable in its R8 target, so this assertion
  // needs no allowance for the beauty pass's half-float rounding.
  const passed = nonfiniteTexels === 0 && min === 1 && max === 1;
  return { passed, width, height, finite: nonfiniteTexels === 0, nonfiniteTexels, min, max, belowNeutralTexels, belowNeutralSamples };
}
