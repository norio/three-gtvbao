export interface LightingImageMetrics {
  passed: boolean;
  maxRgbError: number;
  maxHalfFloatUlps: number;
  meanLuminanceRatio: number;
  severeDarkeningFraction: number;
  comparedPixels: number;
}

// Identity checks use the unoccluded render from this same renderer/session,
// avoiding driver-specific golden-image rounding. The other limits detect a
// collapsed lighting graph; they are deliberately not AO quality thresholds.
export function compareLightingImage(
  actual: Float32Array,
  reference: Float32Array,
  width: number,
  height: number,
  expectIdentity: boolean,
): LightingImageMetrics {
  if (actual.length !== width * height * 4 || reference.length !== actual.length) {
    throw new Error("Lighting image dimensions do not match");
  }
  let maxRgbError = 0;
  let maxHalfFloatUlps = 0;
  let referenceLight = 0;
  let actualLight = 0;
  let severeDarkening = 0;
  let comparedPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const error = Math.abs(actual[i + c] - reference[i + c]);
        maxRgbError = Math.max(maxRgbError, error);
        // The beauty passes store binary16 even though readback is Float32.
        // Permit one adjacent representable value, using the smaller magnitude
        // so crossing a power-of-two boundary cannot hide two smaller steps.
        const magnitude = Math.min(Math.abs(actual[i + c]), Math.abs(reference[i + c]));
        const halfFloatUlp = Math.max(2 ** -24, 2 ** (Math.floor(Math.log2(magnitude)) - 10));
        maxHalfFloatUlps = Math.max(maxHalfFloatUlps, error / halfFloatUlp);
      }
      // The fixed example camera puts the architectural study in this region.
      // Exclude the outer background and already-dark reference pixels, which
      // could otherwise conceal black geometry in a whole-image average.
      if (x < width * 0.1 || x >= width * 0.9 || y < height * 0.1 || y >= height * 0.9) continue;
      const luminance = (pixels: Float32Array) => pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
      const before = luminance(reference);
      if (before < 0.02) continue;
      const after = luminance(actual);
      referenceLight += before;
      actualLight += after;
      if (after < before * 0.05) severeDarkening++;
      comparedPixels++;
    }
  }
  const meanLuminanceRatio = actualLight / referenceLight;
  const severeDarkeningFraction = severeDarkening / comparedPixels;
  const passed = actual.every(Number.isFinite) && reference.every(Number.isFinite) && comparedPixels > 0 &&
    (expectIdentity
      ? maxHalfFloatUlps <= 1 && Math.abs(meanLuminanceRatio - 1) <= 1e-5
      : meanLuminanceRatio >= 0.5 && severeDarkeningFraction <= 0.1);
  return { passed, maxRgbError, maxHalfFloatUlps, meanLuminanceRatio, severeDarkeningFraction, comparedPixels };
}
