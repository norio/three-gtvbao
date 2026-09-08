import * as THREE from "three/webgpu";
import { ivec2, screenCoordinate, texture, vec4 } from "three/tsl";
import GTVBAONode from "../../src/GTVBAONode.js";
import { assertBackend, forceWebGL, renderProbe, requestedBackend } from "./backend.js";

type Size = { width: number; height: number; depthWidth: number; depthHeight: number };
type Mip = { width: number; height: number; data: number[] };
type Prefilter = {
  setSize(width: number, height: number, depthWidth: number, depthHeight: number): void;
  setLogarithmicDepthBuffer(value: boolean): void;
  compute(renderer: THREE.WebGPURenderer): void;
};
const NEAR = 1;
const FAR = 100;
const RANGE = 2;
const TOLERANCE = 2e-4;
const orthographic = new URLSearchParams(location.search).get("camera") === "orthographic";
const sizes: Size[] = [
  { width: 31, height: 19, depthWidth: 62, depthHeight: 57 },
  { width: 10, height: 7, depthWidth: 23, depthHeight: 21 },
  { width: 1, height: 1, depthWidth: 3, depthHeight: 2 },
  { width: 23, height: 31, depthWidth: 47, depthHeight: 93 },
  { width: 1, height: 33, depthWidth: 3, depthHeight: 67 },
  { width: 33, height: 1, depthWidth: 67, depthHeight: 3 },
  { width: 2, height: 2, depthWidth: 5, depthHeight: 7 },
  // Level 1 has exactly 64 texels, then 72: a full workgroup and padding.
  { width: 16, height: 16, depthWidth: 32, depthHeight: 32 },
  { width: 18, height: 16, depthWidth: 37, depthHeight: 33 },
];

function fixture(size: Size, logarithmic: boolean, revision: number) {
  const encoded = Float32Array.from({ length: size.depthWidth * size.depthHeight }, (_, index) => {
    const x = index % size.depthWidth;
    const y = Math.floor(index / size.depthWidth);
    // Asymmetry in both axes exposes flipped render targets; the abrupt step
    // and slope exercise far-depth weighting and odd-size boundary handling.
    const distance = revision === 0
      ? 2 + x * 0.031 + y * 0.019 + (x > size.depthWidth / 2 ? 3 : 0)
      : 8 - x * 0.023 - y * 0.011 + (y < size.depthHeight / 2 ? 2 : 0);
    return orthographic ? (distance - NEAR) / (FAR - NEAR)
      : logarithmic ? Math.log(distance / NEAR) / Math.log(FAR / NEAR)
      : FAR * (distance - NEAR) / (distance * (FAR - NEAR));
  });
  const source = new THREE.DataTexture(encoded, size.depthWidth, size.depthHeight, THREE.RedFormat, THREE.FloatType);
  source.needsUpdate = true;
  // Decode the actual f32 fixture, so encoding roundoff is not blamed on the
  // production shader's linear-depth conversion.
  const linear = Array.from(encoded, depth => orthographic
    ? NEAR + depth * (FAR - NEAR)
    : logarithmic
    ? NEAR * Math.pow(FAR / NEAR, depth)
    : NEAR * FAR / (FAR + depth * (NEAR - FAR)));
  return { source, linear };
}

function referenceMips(size: Size, depth: number[]): Mip[] {
  const filtered = (values: number[]) => {
    const furthest = Math.max(...values);
    const weights = values.map(value => Math.min(1, Math.max(0, (RANGE - furthest + value) / (RANGE * 0.615))));
    return values.reduce((sum, value, index) => sum + value * weights[index], 0)
      / weights.reduce((sum, value) => sum + value, 0);
  };
  const decimate = (x: number, y: number) => {
    const sourceX = Math.floor((Math.min(x, size.width - 1) * 2 + 1) * size.depthWidth / (2 * size.width));
    const sourceY = Math.floor((Math.min(y, size.height - 1) * 2 + 1) * size.depthHeight / (2 * size.height));
    return depth[sourceY * size.depthWidth + sourceX];
  };
  const downsample = (load: (x: number, y: number) => number, x: number, y: number) =>
    filtered([load(x * 2, y * 2), load(x * 2 + 1, y * 2), load(x * 2, y * 2 + 1), load(x * 2 + 1, y * 2 + 1)]);
  const levels: Mip[] = [];
  let { width, height } = size;
  for (let level = 0; level < 5; level++) {
    let load: (x: number, y: number) => number = decimate;
    if (level === 1) load = (x, y) => downsample(decimate, x, y);
    if (level >= 2) {
      const level1 = levels[1];
      load = (x, y) => level1.data[Math.min(y, level1.height - 1) * level1.width + Math.min(x, level1.width - 1)];
      // The compute algorithm recomputes coarser mips from level 1 and clamps
      // only those reads. Sequentially clamping each mip has different edges.
      for (let index = 2; index <= level; index++) {
        const previous = load;
        load = (x, y) => downsample(previous, x, y);
      }
    }
    levels.push({ width, height, data: Array.from({ length: width * height }, (_, index) => load(index % width, Math.floor(index / width))) });
    width = Math.ceil(width / 2);
    height = Math.ceil(height / 2);
  }
  return levels;
}

async function run() {
  const renderer = new THREE.WebGPURenderer({ forceWebGL, antialias: false });
  renderer.setSize(64, 64);
  await renderer.init();
  assertBackend(renderer);
  const camera = orthographic
    ? new THREE.OrthographicCamera(-4, 4, 4, -4, NEAR, FAR)
    : new THREE.PerspectiveCamera(55, 1, NEAR, FAR);
  const placeholder = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType);
  const depthNode = texture(placeholder);
  const ao = new GTVBAONode(depthNode, null, camera, { useDepthMips: true });
  ao.maxThickness.value = RANGE;
  const prefilter = (ao as unknown as { _depthPrefilter: Prefilter })._depthPrefilter;
  const mipNodes = ao.getDepthMipNodes();
  const results = [];
  try {
    // One prefilter survives every resize and both changes of depth mode.
    for (const logarithmic of [false, true, false]) {
      prefilter.setLogarithmicDepthBuffer(logarithmic);
      for (const size of sizes) {
        // The second upload keeps every output allocation alive. All texels
        // must be overwritten rather than relying on a newly cleared target.
        for (const revision of [0, 1]) {
          const { source, linear } = fixture(size, logarithmic, revision);
          depthNode.value = source;
          try {
            prefilter.setSize(size.width, size.height, size.depthWidth, size.depthHeight);
            prefilter.compute(renderer);
            const expectedMips = referenceMips(size, linear);
            for (const [level, expected] of expectedMips.entries()) {
              const pixels = await renderProbe(renderer, vec4(mipNodes[level].load(ivec2(screenCoordinate)).r, 0, 0, 1), expected.width, expected.height);
              let maxError = 0;
              for (const [index, value] of expected.data.entries()) {
                const error = Math.abs(pixels[index * 4] - value);
                if (!Number.isFinite(error)) throw new Error(`Nonfinite mip ${level}`);
                maxError = Math.max(maxError, error);
              }
              results.push({ logarithmic, size: `${size.width}x${size.height}`, revision, level, texels: expected.data.length, maxError, passed: maxError <= TOLERANCE });
            }
          } finally {
            source.dispose();
          }
        }
      }
    }
    return { backend: requestedBackend, camera: orthographic ? "orthographic" : "perspective", tolerance: TOLERANCE, passed: results.every(entry => entry.passed), results };
  } finally {
    ao.dispose();
    placeholder.dispose();
    renderer.dispose();
  }
}

const result = await run().catch(error => ({ passed: false, error: String(error) }));
Object.assign(window, { depthMipRegression: result });
document.querySelector("#status")!.textContent = "results" in result
  ? `${result.passed ? "PASS" : "FAIL"} — ${result.backend}\n` + result.results.map(entry =>
    `${entry.passed ? "PASS" : "FAIL"}  ${entry.logarithmic ? "log" : "normal"} / ${entry.size} / upload ${entry.revision} / mip ${entry.level}: max error ${entry.maxError.toExponential(3)}`).join("\n")
  : result.error;
