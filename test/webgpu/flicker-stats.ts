export function boxFilter(
  source: Float64Array, scratch: Float64Array, output: Float64Array,
  width: number, height: number, blur: number,
) {
  // Even windows include the extra texel on the negative side of each axis.
  const before = Math.floor(blur / 2);
  const after = blur - before - 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x <= Math.min(after, width - 1); x++) sum += source[row + x];
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - before);
      const right = Math.min(width - 1, x + after);
      scratch[row + x] = sum / (right - left + 1);
      if (x - before >= 0) sum -= source[row + x - before];
      if (x + after + 1 < width) sum += source[row + x + after + 1];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(after, height - 1); y++) sum += scratch[y * width + x];
    for (let y = 0; y < height; y++) {
      const top = Math.max(0, y - before);
      const bottom = Math.min(height - 1, y + after);
      output[y * width + x] = sum / (bottom - top + 1);
      if (y - before >= 0) sum -= scratch[(y - before) * width + x];
      if (y + after + 1 < height) sum += scratch[(y + after + 1) * width + x];
    }
  }
}

export function createAccumulator(blur: number, count: number) {
  return {
    blur, sum: new Float64Array(count), sumSquares: new Float64Array(count),
    deltas: new Float64Array(count), previous: new Float64Array(count),
  };
}

export function accumulate(
  { sum, sumSquares, deltas, previous }: ReturnType<typeof createAccumulator>, luma: Float64Array, frame: number,
) {
  for (let i = 0; i < luma.length; i++) {
    sum[i] += luma[i];
    sumSquares[i] += luma[i] * luma[i];
    if (frame > 1) deltas[i] += Math.abs(luma[i] - previous[i]);
    previous[i] = luma[i];
  }
}

export function summarize({ blur, sum, sumSquares, deltas }: ReturnType<typeof createAccumulator>, frames: number) {
  const count = sum.length;
  const mean = sum;
  const std = new Float64Array(count);
  let totalMean = 0;
  let totalStd = 0;
  let totalDelta = 0;
  for (let i = 0; i < count; i++) {
    mean[i] /= frames;
    std[i] = Math.sqrt(Math.max(0, sumSquares[i] / frames - mean[i] * mean[i]));
    totalMean += mean[i];
    totalStd += std[i];
    totalDelta += deltas[i];
  }
  const sorted = std.slice().sort();
  const percentile = (p: number) => {
    const index = (count - 1) * p;
    const lower = Math.floor(index);
    return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
  };
  return {
    blur, mean, std, meanLuma: totalMean / count,
    temporalStd: {
      mean: totalStd / count, p50: percentile(0.5), p95: percentile(0.95),
      p99: percentile(0.99), max: sorted[count - 1],
    },
    frameDelta: frames > 1 ? totalDelta / (count * (frames - 1)) : 0,
  };
}
