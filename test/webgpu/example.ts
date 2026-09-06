import * as THREE from "three/webgpu";
import { screenUV, texture } from "three/tsl";
import { GTVBAO_PASS_NAMES } from "../../src/index.js";
import {
  renderer, scene, camera, controls, aoNode, denoiseNode, prePass, pipeline, settings, syncOutput,
} from "../../example/main.js";

import { assertBackend, readFloatTarget, reportProgress } from "./backend.js";

const WIDTH = 320;
const HEIGHT = 240;
renderer.setAnimationLoop(null);
document.querySelector(".lil-gui.root")?.remove();
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT);
camera.aspect = WIDTH / HEIGHT;
camera.updateProjectionMatrix();
controls.enableDamping = false;
controls.update();
// Freeze the moving ceramic at the same pose even if the example rendered
// an animation frame before this module finished loading.
scene.getObjectByName("Rotating ceramic")!.rotation.y = 0;
// Compare linear values before display conversion, including the raw debug RGB.
pipeline.outputColorTransform = false;
pipeline.needsUpdate = true;
const target = new THREE.RenderTarget(WIDTH, HEIGHT, { type: THREE.FloatType, depthBuffer: false });

// The denoiser's default SimplexNoise uses Math.random(). Supply deterministic
// rotation noise so separate baseline/current pages have comparable images.
const noiseTexture = new THREE.DataTexture(
  Uint8Array.from({ length: 64 * 64 * 4 }, (_, i) => (i * 73 + (i >> 8) * 37) % 256), 64, 64,
);
noiseTexture.wrapS = noiseTexture.wrapT = THREE.RepeatWrapping;
noiseTexture.needsUpdate = true;
const denoiseInternals = denoiseNode as unknown as { noiseNode: ReturnType<typeof texture> | null };
denoiseInternals.noiseNode?.value.dispose();
denoiseInternals.noiseNode = texture(noiseTexture);

type Counts = { pre: number; lit: number; ao: number; denoise: number; compute: number; depthMip: number };
const emptyCounts = (): Counts => ({ pre: 0, lit: 0, ao: 0, denoise: 0, compute: 0, depthMip: 0 });
let counts = emptyCounts();
// The installed backend exposes these hooks, but @types/three omits them.
const backend = renderer.backend as typeof renderer.backend & {
  beginRender(context: { renderTarget: THREE.RenderTarget | null; camera: THREE.Camera | null }): void;
  beginCompute(group: unknown): void;
};
const beginRender = backend.beginRender.bind(backend);
const beginCompute = backend.beginCompute.bind(backend);
backend.beginRender = (context) => {
  beginRender(context);
  if (context.renderTarget === prePass.renderTarget) counts.pre++;
  else if (context.camera === camera) counts.lit++;
  const name = context.renderTarget?.texture.name;
  if (name === GTVBAO_PASS_NAMES.ao || name === GTVBAO_PASS_NAMES.debug) counts.ao++;
  if (name === GTVBAO_PASS_NAMES.denoise) counts.denoise++;
  if (name?.startsWith("GTVBAO.DepthMip.")) counts.depthMip++;
};
backend.beginCompute = (group) => {
  beginCompute(group);
  counts.compute++;
};

function showPixels(label: string, pixels: Float32Array) {
  const section = document.createElement("section");
  const title = document.createElement("h2");
  title.textContent = label;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(WIDTH, HEIGHT);
  for (let i = 0; i < pixels.length; i++) image.data[i] = Math.round(pixels[i] * 255);
  context.putImageData(image, 0, 0);
  section.append(title, canvas);
  document.querySelector("#images")!.append(section);
}

function assertFiniteCamera(scenario: string) {
  const values = {
    aspect: [camera.aspect],
    position: camera.position.toArray(),
    projection: camera.projectionMatrix.elements,
    projectionInverse: camera.projectionMatrixInverse.elements,
    world: camera.matrixWorld.elements,
    worldInverse: camera.matrixWorldInverse.elements,
  };
  for (const [name, components] of Object.entries(values)) {
    if (!components.every(Number.isFinite)) throw new Error(`Nonfinite camera ${name} in ${scenario}`);
  }
}

async function readOutput(output = pipeline) {
  renderer.setRenderTarget(target);
  output.render();
  assertFiniteCamera("reference output");
  return await readFloatTarget(renderer, target);
}

function renderFrames(scenario: string) {
  reportProgress(`${scenario}: waiting for frame 1/5`);
  // The renderer's animation loop advances NodeFrame's FRAME guard. Calling
  // render() repeatedly in one frame would only rerun the final screen quad.
  return new Promise<{ pixels: Float32Array; observed: Counts }>((resolve, reject) => {
    let frames = 0;
    renderer.setAnimationLoop(() => {
      try {
        counts = emptyCounts();
        renderer.setRenderTarget(target);
        reportProgress(`${scenario}: rendering frame ${frames + 1}/5`);
        pipeline.render();
        assertFiniteCamera(`${scenario}, frame ${frames + 1}/5`);
        reportProgress(`${scenario}: rendered frame ${frames + 1}/5`);
        if (++frames === 5) {
          renderer.setAnimationLoop(null);
          const observed = { ...counts };
          readFloatTarget(renderer, target)
            .then(pixels => resolve({ pixels: pixels as Float32Array, observed }), reject);
        }
      } catch (error) {
        renderer.setAnimationLoop(null);
        reject(error);
      }
    });
  });
}

type Scenario = { name: string; enabled: boolean; traa: boolean; only?: boolean; denoise?: boolean; debug?: number; temporal?: boolean };
const scenarios: Scenario[] = [
  // Match the public view buttons: Showcase keeps temporal sampling and TRAA
  // enabled when entering AO-only, including its first RTT allocation.
  { name: "ui-full-initial", enabled: true, traa: true, temporal: true },
  { name: "ui-ao-only-initial", enabled: true, traa: true, temporal: true, only: true },
  { name: "ui-full-return", enabled: true, traa: true, temporal: true },
  { name: "ui-off", enabled: false, traa: true, temporal: true },
  { name: "ui-ao-only-return", enabled: true, traa: true, temporal: true, only: true },
  { name: "ui-full-final", enabled: true, traa: true, temporal: true },
  { name: "ui-denoised-ao-only-initial", enabled: true, traa: true, temporal: true, only: true, denoise: true },
  { name: "ui-denoised-full", enabled: true, traa: true, temporal: true, denoise: true },
  { name: "ui-denoised-ao-only-return", enabled: true, traa: true, temporal: true, only: true, denoise: true },
  { name: "ui-denoised-full-return", enabled: true, traa: true, temporal: true, denoise: true },
  // Exercise denoised + TRAA. Returning from AO-off must rebind
  // the cached beauty target without sampling a disposed GPU texture.
  { name: "showcase-initial", enabled: true, traa: true, denoise: true },
  { name: "showcase-off", enabled: false, traa: true },
  { name: "showcase-return", enabled: true, traa: true, denoise: true },
  { name: "off-direct", enabled: false, traa: false },
  { name: "off-traa", enabled: false, traa: true },
  { name: "off-direct-return", enabled: false, traa: false },
  { name: "raw-lit", enabled: true, traa: false },
  { name: "denoised-lit", enabled: true, traa: false, denoise: true },
  { name: "ao-only", enabled: true, traa: false, only: true },
  { name: "denoised-ao-only", enabled: true, traa: false, only: true, denoise: true },
  { name: "ao-off-only", enabled: false, traa: false, only: true },
  ...[1, 2, 3, 4, 5].map(debug => ({ name: `debug-${debug}`, enabled: true, traa: true, denoise: true, debug })),
  { name: "debug-ao-off", enabled: false, traa: true, denoise: true, debug: 5 },
  { name: "after-debug-lit", enabled: true, traa: false },
  { name: "after-debug-ao-only", enabled: true, traa: false, only: true },
  { name: "raw-lit-traa", enabled: true, traa: true },
  { name: "denoised-lit-traa", enabled: true, traa: true, denoise: true },
  { name: "debug-return", enabled: true, traa: false, debug: 5 },
  { name: "final-off-direct", enabled: false, traa: false },
];

async function run() {
  const backendName = assertBackend(renderer);
  const results = [];
  for (const scenario of scenarios) {
    const debug = scenario.debug ?? 0;
    const only = scenario.only ?? false;
    const denoise = scenario.denoise ?? false;
    Object.assign(settings, {
      aoEnabled: scenario.enabled, aoOnly: only, denoise,
      traa: scenario.traa, temporal: scenario.temporal ?? false,
    });
    aoNode.debugMode.value = debug;
    reportProgress(`${scenario.name}: synchronizing output`);
    syncOutput();
    const { pixels, observed } = await renderFrames(scenario.name);
    const runsAo = scenario.enabled || only || debug > 0;
    const expected = {
      pre: runsAo || scenario.traa ? 1 : 0,
      lit: only || debug > 0 ? 0 : 1,
      ao: runsAo ? 1 : 0,
      denoise: runsAo && denoise && debug === 0 && scenario.enabled ? 1 : 0,
      compute: runsAo && backendName === "WebGPU" ? 2 : 0,
      depthMip: runsAo && backendName === "WebGL2" ? 5 : 0,
    };
    let passed = Object.entries(expected).every(([key, value]) => observed[key as keyof Counts] === value);
    if (!pixels.every(Number.isFinite)) throw new Error(`Nonfinite output in ${scenario.name}`);
    let maxDebugError = 0;
    if (debug > 0) {
      // Read the exact rendered AO texture, without its PassNode dependency,
      // so the reference cannot advance the AO frame or reapply denoising.
      const reference = new THREE.RenderPipeline(renderer, texture(aoNode.getTextureNode().value).sample(screenUV));
      reference.outputColorTransform = false;
      try {
        const expectedPixels = await readOutput(reference);
        for (let i = 0; i < pixels.length; i++) maxDebugError = Math.max(maxDebugError, Math.abs(pixels[i] - expectedPixels[i]));
        passed &&= maxDebugError <= 1e-6;
      } finally {
        reference.dispose();
      }
    }
    const digest = await crypto.subtle.digest("SHA-256", pixels.buffer as ArrayBuffer);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    results.push({ name: scenario.name, passed, observed, expected, maxDebugError, hash });
    if (["off-direct", "raw-lit", "ao-only", "debug-5"].includes(scenario.name)) showPixels(scenario.name, pixels);
  }
  return { backend: backendName, passed: results.every(result => result.passed), results };
}

try {
  const result = await run();
  Object.assign(window, { exampleRegression: result });
  document.querySelector("#status")!.textContent = `${result.passed ? "PASS" : "FAIL"} — ${result.backend}\n` +
    result.results.map(entry => `${entry.passed ? "PASS" : "FAIL"} ${entry.name}: passes ${JSON.stringify(entry.observed)}, debug error ${entry.maxDebugError.toExponential(2)}`).join("\n");
} catch (error) {
  const result = { passed: false, error: String(error) };
  Object.assign(window, { exampleRegression: result });
  document.querySelector("#status")!.textContent = JSON.stringify(result);
} finally {
  renderer.setRenderTarget(null);
  backend.beginRender = beginRender;
  backend.beginCompute = beginCompute;
  target.dispose();
  noiseTexture.dispose();
}
