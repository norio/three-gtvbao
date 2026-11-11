import * as THREE from "three/webgpu";
import { screenUV, texture, vec4 } from "three/tsl";
import { GTVBAONode, GTVBAODenoiseNode } from "../../src/index.js";
import { assertBackend, forceWebGL, renderProbe, reportProgress, requestedBackend } from "./backend.js";

const SIZE = 96;
const TOLERANCE = 2 / 255;
// Both slice modes generate the same shader for an orthographic camera.
const SLICE_MODE_TOLERANCE = 1e-6;
const scenarios = [
  { name: "world-radius", mips: false, scale: 1, screenSpace: false, normals: true },
  { name: "world-radius-mips", mips: true, scale: 1, screenSpace: false, normals: true },
  { name: "half-denoise-upsample", mips: true, scale: 0.5, screenSpace: false, normals: true },
  { name: "screen-radius-depth-normal", mips: false, scale: 0.5, screenSpace: true, normals: false },
];
type Scenario = typeof scenarios[number];
type Updatable = { updateBefore(frame: { renderer: THREE.WebGPURenderer; frameId: number }): void };

function image(label: string, pixels: Float32Array) {
  const section = document.createElement("section");
  const title = document.createElement("h2");
  title.textContent = label;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE * 2;
  canvas.height = SIZE;
  const context = canvas.getContext("2d")!;
  const data = context.createImageData(canvas.width, SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    for (let channel = 0; channel < 2; channel++) {
      const index = (y * canvas.width + x + channel * SIZE) * 4;
      data.data.fill(Math.round(pixels[(y * SIZE + x) * 4 + channel] * 255), index, index + 3);
      data.data[index + 3] = 255;
    }
  }
  context.putImageData(data, 0, 0);
  section.append(title, canvas);
  document.querySelector("#images")!.append(section);
}

async function checkTranslation(renderer: THREE.WebGPURenderer, scenario: Scenario) {
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0, 32);
  camera.coordinateSystem = renderer.coordinateSystem;
  camera.updateProjectionMatrix();
  const depthData = new Float32Array(SIZE * SIZE);
  const depthTexture = new THREE.DataTexture(depthData, SIZE, SIZE, THREE.RedFormat, THREE.FloatType);
  const normalTexture = new THREE.DataTexture(new Float32Array([0, 0, 1, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  normalTexture.needsUpdate = true;
  const depthNode = texture(depthTexture);
  const normalNode = scenario.normals ? texture(normalTexture) : null;
  const ao = new GTVBAONode(depthNode, normalNode, camera, {
    useDepthMips: scenario.mips, resolutionScale: scenario.scale,
    useTemporalFiltering: false, useLinearThickness: false,
    useScreenSpaceSampling: scenario.screenSpace, radius: scenario.screenSpace ? 3 : 1.5,
    thickness: 0.5, maxThickness: 1, sliceCount: 4, stepCount: 12,
  });
  const denoise = new GTVBAODenoiseNode(texture(ao.getTextureNode().value), depthNode, normalNode, camera,
    { linearDepthSource: scenario.mips ? ao : null });
  const noise = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  noise.needsUpdate = true;
  denoise.noiseNode = texture(noise);
  const builder = { renderer, getSharedContext: () => ({}) };
  ao.setup(builder as never);
  denoise.setup(builder as never);
  const captures: Float32Array[] = [];
  try {
    for (const distance of [3, 13]) {
      // Two front-facing planes form a rectangular raised step. Translating the
      // camera along its view axis changes only depth, not UVs, normals or AO.
      // Project each fixture through three's camera matrix, independently of the
      // production depth decoder. Use binary-exact depths so float cancellation
      // cannot push the discrete AO bitmask across a sector boundary.
      // Orthographic depth stays linear even when the
      // renderer's logarithmicDepthBuffer option is enabled.
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        const raised = x >= 24 && x < 62 && y >= 30 && y < 68;
        const z = distance - (raised ? 0.5 : 0);
        const clip = new THREE.Vector3(0, 0, -z).applyMatrix4(camera.projectionMatrix).z;
        depthData[y * SIZE + x] = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? clip : clip * 0.5 + 0.5;
      }
      depthTexture.needsUpdate = true;
      reportProgress(`${scenario.name}: camera distance ${distance}`);
      (ao as unknown as Updatable).updateBefore({ renderer, frameId: 0 });
      (denoise as unknown as Updatable).updateBefore({ renderer, frameId: 0 });
      const raw = texture(ao.getTextureNode().value).sample(screenUV).r;
      const filtered = ao.createDepthAwareAoFromBuffers(
        texture(denoise.getTextureNode().value), depthNode, texture(normalTexture), screenUV);
      captures.push(await renderProbe(renderer, vec4(raw, filtered, 0, 1), SIZE, SIZE));
    }
    image(`${renderer.logarithmicDepthBuffer ? "log flag" : "normal"} / ${scenario.name}`, captures[0]);
    const channels = ["raw AO", "denoised + upsampled AO"].map((label, channel) => {
      let maxError = 0;
      let squaredError = 0;
      let minAo = 1;
      let maxAo = 0;
      for (let index = channel; index < captures[0].length; index += 4) {
        const a = captures[0][index];
        const b = captures[1][index];
        if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Nonfinite AO: ${scenario.name}`);
        const error = Math.abs(a - b);
        maxError = Math.max(maxError, error);
        squaredError += error * error;
        minAo = Math.min(minAo, a, b);
        maxAo = Math.max(maxAo, a, b);
      }
      // The scene must contain real occlusion and unoccluded pixels: a blank
      // texture is not evidence that camera translation preserves AO.
      return { label, maxError, rmse: Math.sqrt(squaredError / (SIZE * SIZE)), minAo, maxAo,
        passed: maxError <= TOLERANCE && minAo < 0.98 && maxAo > 0.99 && minAo >= 0 && maxAo <= 1 };
    });
    return { name: scenario.name, logarithmicDepthBuffer: renderer.logarithmicDepthBuffer,
      passed: channels.every(channel => channel.passed), channels };
  } finally {
    denoise.dispose();
    ao.dispose();
    depthTexture.dispose();
    normalTexture.dispose();
  }
}

// usePerspectiveCorrectSlice only selects the slice distribution for perspective
// cameras, so an orthographic camera must produce bit-identical raw AO either way.
// The plane normal of a slice has to come from the view direction in both modes:
// the two formulas only agree where the surface normal is parallel to the view
// axis, so the fixture is a tilted plane (supplied normals consistent with its
// depth) carrying a raised block, never a head-on surface.
async function checkSliceModeInvariance(renderer: THREE.WebGPURenderer) {
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0, 32);
  camera.coordinateSystem = renderer.coordinateSystem;
  camera.updateProjectionMatrix();
  const slopeX = 0.5;
  const slopeY = 0.25;
  const depthData = new Float32Array(SIZE * SIZE);
  const normalData = new Float32Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    // View-space plane z = -(10 + slopeX*vx + slopeY*vy), lifted 1 toward the camera inside the block.
    // Its normal (slopeX, slopeY, 1) tilts about 29 degrees away from the view axis.
    const viewX = (x + 0.5) / SIZE * 4 - 2;
    const viewY = 2 - (y + 0.5) / SIZE * 4;
    const raised = x >= 24 && x < 62 && y >= 30 && y < 68;
    const z = 10 + slopeX * viewX + slopeY * viewY - (raised ? 1 : 0);
    const clip = new THREE.Vector3(0, 0, -z).applyMatrix4(camera.projectionMatrix).z;
    depthData[y * SIZE + x] = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? clip : clip * 0.5 + 0.5;
    normalData.set([slopeX, slopeY, 1, 1], (y * SIZE + x) * 4);
  }
  const depthTexture = new THREE.DataTexture(depthData, SIZE, SIZE, THREE.RedFormat, THREE.FloatType);
  const normalTexture = new THREE.DataTexture(normalData, SIZE, SIZE, THREE.RGBAFormat, THREE.FloatType);
  depthTexture.needsUpdate = true;
  normalTexture.needsUpdate = true;
  const nodes = [true, false].map(usePerspectiveCorrectSlice => new GTVBAONode(
    texture(depthTexture), texture(normalTexture), camera, {
      useDepthMips: false, resolutionScale: 1, useTemporalFiltering: false, useLinearThickness: false,
      useScreenSpaceSampling: false, radius: 1.5, thickness: 0.5, maxThickness: 1, sliceCount: 4, stepCount: 12,
      usePerspectiveCorrectSlice,
    }));
  try {
    const builder = { renderer, getSharedContext: () => ({}) };
    for (const ao of nodes) {
      ao.setup(builder as never);
      reportProgress(`slice-mode-invariance: usePerspectiveCorrectSlice ${ao.usePerspectiveCorrectSlice.value}`);
      (ao as unknown as Updatable).updateBefore({ renderer, frameId: 0 });
    }
    const [correct, imagePlane] = nodes.map(ao => texture(ao.getTextureNode().value).sample(screenUV).r);
    const pixels = await renderProbe(renderer, vec4(correct, imagePlane, 0, 1), SIZE, SIZE);
    image(`${renderer.logarithmicDepthBuffer ? "log flag" : "normal"} / slice-mode-invariance (perspective-correct | image-plane)`, pixels);
    let maxError = 0;
    let squaredError = 0;
    let minAo = 1;
    let maxAo = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const a = pixels[index];
      const b = pixels[index + 1];
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Nonfinite AO: slice-mode-invariance");
      const error = Math.abs(a - b);
      maxError = Math.max(maxError, error);
      squaredError += error * error;
      minAo = Math.min(minAo, a, b);
      maxAo = Math.max(maxAo, a, b);
    }
    // Real occlusion must be present, or identical images would prove nothing.
    const channel = { label: "raw AO, usePerspectiveCorrectSlice true vs false", maxError,
      rmse: Math.sqrt(squaredError / (SIZE * SIZE)), minAo, maxAo, tolerance: SLICE_MODE_TOLERANCE,
      passed: maxError <= SLICE_MODE_TOLERANCE && minAo < 0.98 && maxAo > 0.99 && minAo >= 0 && maxAo <= 1 };
    return { name: "slice-mode-invariance", logarithmicDepthBuffer: renderer.logarithmicDepthBuffer,
      passed: channel.passed, channels: [channel] };
  } finally {
    for (const ao of nodes) ao.dispose();
    depthTexture.dispose();
    normalTexture.dispose();
  }
}

async function run() {
  const results = [];
  for (const logarithmicDepthBuffer of [false, true]) {
    const renderer = new THREE.WebGPURenderer({ forceWebGL, logarithmicDepthBuffer, antialias: false });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE);
    try {
      await renderer.init();
      assertBackend(renderer);
      for (const scenario of scenarios) results.push(await checkTranslation(renderer, scenario));
      results.push(await checkSliceModeInvariance(renderer));
    } finally {
      renderer.dispose();
    }
  }
  return { backend: requestedBackend, tolerance: TOLERANCE, passed: results.every(result => result.passed), results };
}
const result = await run().catch(error => ({ passed: false, error: String(error) }));
Object.assign(window, { orthographicRegression: result });
document.querySelector("#status")!.textContent = JSON.stringify(result, null, 2);
