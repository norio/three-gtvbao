import * as THREE from "three/webgpu";
import { screenUV, texture } from "three/tsl";
import { gtvbao } from "../../src/index.js";
import { assertBackend, forceWebGL, readFloatTarget, reportProgress } from "./backend.js";

const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL });
renderer.setPixelRatio(1);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
const depthSize = 32;
const depths = new Float32Array(depthSize * depthSize);
for (let y = 0; y < depthSize; y++) {
  for (let x = 0; x < depthSize; x++) {
    // An asymmetric foreground step and sloping background prevent constant AO.
    depths[y * depthSize + x] = x < 13 && y > 8 ? 0.955 : 0.98 + x * 0.0002;
  }
}
const depth = new THREE.DataTexture(depths, depthSize, depthSize, THREE.RedFormat, THREE.FloatType);
depth.needsUpdate = true;
const target = new THREE.RenderTarget(32, 32, { type: THREE.FloatType, depthBuffer: false });
type Case = { name: string; mode: number; size?: number; scale?: number; batch?: boolean };
type Result = {
  name: string; passed: boolean; maxRgbaError: number; finite: boolean;
  referenceRange: number; debugColorRange: number; width: number; height: number;
};
const results: Result[] = [];

// Exactly one native renderer frame advances the FRAME update guard. Pause
// before readback, so the reference samples precisely that producer output.
function firstFrame(pipeline: THREE.RenderPipeline, name: string) {
  return new Promise<void>((resolve, reject) => {
    renderer.setAnimationLoop(() => {
      renderer.setAnimationLoop(null);
      try {
        reportProgress(`${name}: first frame`);
        renderer.setRenderTarget(target);
        pipeline.render();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runSequence(initialMode: number, cases: Case[]) {
  const ao = gtvbao(texture(depth), null, camera, {
    debugMode: initialMode, useTemporalFiltering: false, useDepthMips: false,
  });
  // Retain this consumer across all transitions, just as an application's graph does.
  const pipeline = new THREE.RenderPipeline(renderer, ao.getTextureNode().sample(screenUV));
  pipeline.outputColorTransform = false;
  ao.setVariantChangeCallback(() => { pipeline.needsUpdate = true; });
  try {
    for (const entry of cases) {
      const size = entry.size ?? 32;
      renderer.setSize(size, size);
      target.setSize(size, size);
      ao.resolutionScale = entry.scale ?? 1;
      if (entry.batch) {
        ao.batchVariantChanges(() => {
          ao.debugMode.value = 2;
          ao.debugMode.value = entry.mode;
        });
      } else {
        ao.debugMode.value = entry.mode;
      }
      await firstFrame(pipeline, entry.name);
      const actual = await readFloatTarget(renderer, target);
      // A fresh ordinary TextureNode has neither cached sample type nor AO pass
      // dependency. It cannot rerender the producer while reading its RGBA output.
      const referencePipeline = new THREE.RenderPipeline(renderer, texture(ao.getTextureNode().value).sample(screenUV));
      referencePipeline.outputColorTransform = false;
      let expected: Float32Array;
      try {
        renderer.setRenderTarget(target);
        referencePipeline.render();
        expected = await readFloatTarget(renderer, target);
      } finally {
        referencePipeline.dispose();
      }
      let maxRgbaError = 0;
      let minRed = Infinity;
      let maxRed = -Infinity;
      let debugColorRange = 0;
      for (let i = 0; i < actual.length; i++) {
        maxRgbaError = Math.max(maxRgbaError, Math.abs(actual[i] - expected[i]));
        if (i % 4 === 0) {
          minRed = Math.min(minRed, expected[i]);
          maxRed = Math.max(maxRed, expected[i]);
          debugColorRange = Math.max(debugColorRange, Math.abs(expected[i] - expected[i + 2]));
        }
      }
      const finite = actual.every(Number.isFinite) && expected.every(Number.isFinite);
      // Jitter mode must contain distinct color channels; a blank or grayscale
      // fixture would not demonstrate that the consumer preserves debug RGB.
      const informative = entry.mode !== 5 || debugColorRange > 0.1;
      const image = ao.getTextureNode().value.image as { width: number; height: number };
      results.push({
        name: entry.name, passed: finite && maxRgbaError <= 1e-6 && informative,
        maxRgbaError, finite, referenceRange: maxRed - minRed, debugColorRange,
        width: image.width, height: image.height,
      });
    }
  } finally {
    renderer.setAnimationLoop(null);
    renderer.setRenderTarget(null);
    pipeline.dispose();
    ao.dispose();
  }
}

function publish(result: object) {
  Object.assign(window, { outputSwitchRegression: result });
  document.querySelector("#status")!.textContent = JSON.stringify(result, null, 2);
}

try {
  await renderer.init();
  const backend = assertBackend(renderer);
  await runSequence(1, [{ name: "constructor-debug-1", mode: 1 }]);
  await runSequence(5, [{ name: "constructor-debug-5", mode: 5 }]);
  await runSequence(0, [
    { name: "initial-ao", mode: 0 },
    { name: "ao-to-debug-1", mode: 1 },
    { name: "debug-1-to-ao", mode: 0 },
    { name: "ao-to-debug-5", mode: 5 },
    { name: "debug-5-to-ao", mode: 0 },
    { name: "cached-debug-return", mode: 5 },
    { name: "debug-resize-half", mode: 5, size: 16, scale: 0.5 },
    { name: "batch-debug-to-ao-half", mode: 0, size: 16, scale: 0.5, batch: true },
    { name: "batch-ao-to-debug-full", mode: 5, batch: true },
    { name: "final-ao", mode: 0 },
  ]);
  publish({ revision: THREE.REVISION, backend, passed: results.every(result => result.passed), results });
} catch (error) {
  publish({ revision: THREE.REVISION, passed: false, error: String(error), results });
} finally {
  renderer.setAnimationLoop(null);
  renderer.setRenderTarget(null);
  target.dispose();
  depth.dispose();
  renderer.dispose();
}
