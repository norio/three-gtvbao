import assert from "node:assert/strict";
import { test } from "vitest";
import { accumulate, boxFilter, createAccumulator, summarize } from "./webgpu/flicker-stats.js";

// Independent oracle: the mean over the in-bounds part of a window that spans
// `blur` texels per axis and holds the extra texel of an even size on the negative side.
function referenceBox(source: number[], width: number, height: number, blur: number) {
  const before = Math.floor(blur / 2);
  const after = blur - 1 - before;
  return source.map((_, index) => {
    const x0 = index % width;
    const y0 = Math.floor(index / width);
    let sum = 0;
    let count = 0;
    for (let y = Math.max(0, y0 - before); y <= Math.min(height - 1, y0 + after); y++) {
      for (let x = Math.max(0, x0 - before); x <= Math.min(width - 1, x0 + after); x++) {
        sum += source[y * width + x];
        count++;
      }
    }
    return sum / count;
  });
}

test("boxFilter averages the in-bounds window of every texel for odd and even sizes", () => {
  const width = 7;
  const height = 5;
  const source = Array.from({ length: width * height }, (_, i) => (i * 37) % 11 + (i % 3));
  for (const blur of [1, 2, 3, 4, 5, 8, 20]) {
    const output = new Float64Array(width * height);
    boxFilter(Float64Array.from(source), new Float64Array(width * height), output, width, height, blur);
    const expected = referenceBox(source, width, height, blur);
    output.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `blur ${blur} texel ${i}: ${value} != ${expected[i]}`));
  }
});

test("summarize reports the temporal mean, standard deviation and frame-to-frame change", () => {
  // Texel 0 alternates 0.2 / 0.8; texel 1 stays at 0.5.
  const accumulator = createAccumulator(1, 2);
  const frames = 6;
  for (let frame = 1; frame <= frames; frame++) {
    accumulate(accumulator, Float64Array.of(frame % 2 ? 0.2 : 0.8, 0.5), frame);
  }
  const summary = summarize(accumulator, frames);

  assert.ok(Math.abs(summary.mean[0] - 0.5) < 1e-12);
  assert.ok(Math.abs(summary.std[0] - 0.3) < 1e-12);
  assert.equal(summary.std[1], 0);
  assert.ok(Math.abs(summary.meanLuma - 0.5) < 1e-12);
  assert.ok(Math.abs(summary.temporalStd.mean - 0.15) < 1e-12);
  assert.ok(Math.abs(summary.temporalStd.max - 0.3) < 1e-12);
  // Only texel 0 changes, by 0.6 on each of the 5 transitions; averaged over both texels.
  assert.ok(Math.abs(summary.frameDelta - 0.3) < 1e-12);
  assert.equal(summarize(createAccumulator(1, 2), 1).frameDelta, 0);
});
