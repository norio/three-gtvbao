import * as THREE from "three/webgpu";
import { abs, screenUV, texture, vec4 } from "three/tsl";
import GTVBAONode from "../../src/GTVBAONode.js";

import { assertBackend, forceWebGL, readFloatTarget, reportProgress, requestedBackend } from "./backend.js";

const WIDTH = 64;
const HEIGHT = 64;
const TOLERANCE = 2e-5;

// Known parallel planes make all four valid depth weights equal. The correct
// result is therefore hardware bilinear AO, independently of depth encoding.
// A nonuniform AO texture exposes incorrectly rejected neighbors (nearest AO).
const scenarios = [
  { name: "half", scale: 0.5, near: 0.1, far: 100, distance: 10 },
  { name: "quarter", scale: 0.25, near: 0.1, far: 100, distance: 10 },
  { name: "full", scale: 1, near: 0.1, far: 100, distance: 10 },
  { name: "wide-range", scale: 0.5, near: 0.1, far: 1e7, distance: 1e5 },
  { name: "encoded-normal", scale: 0.5, near: 1, far: 1000, distance: 50, encoded: true },
  { name: "mips-off", scale: 0.5, near: 0.1, far: 100, distance: 10, mips: false },
  { name: "upsample-off", scale: 0.5, near: 0.1, far: 100, distance: 10, upsample: false },
];

type Scenario = (typeof scenarios)[number];
type AoInternals = {
  _logarithmicDepthBuffer: boolean;
  updateBefore(frame: { renderer: THREE.WebGPURenderer; frameId: number }): void;
};

function makeTexture(data: Float32Array | Uint8Array, width: number, height: number, rgba = false) {
  const result = new THREE.DataTexture(data, width, height,
    rgba ? THREE.RGBAFormat : THREE.RedFormat,
    data instanceof Float32Array ? THREE.FloatType : THREE.UnsignedByteType);
  result.needsUpdate = true;
  return result;
}

function showPixels(label: string, pixels: Float32Array) {
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = label;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * 3;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      for (let channel = 0; channel < 3; channel++) {
        const source = (y * WIDTH + x) * 4 + channel;
        const target = (y * canvas.width + channel * WIDTH + x) * 4;
        image.data.fill(Math.round(pixels[source] * 255 * (channel === 2 ? 4 : 1)), target, target + 3);
        image.data[target + 3] = 255;
      }
    }
  }
  context.putImageData(image, 0, 0);
  section.append(heading, canvas);
  document.querySelector("#images")!.append(section);
}

async function runScenario(renderer: THREE.WebGPURenderer, scenario: Scenario) {
  const { near, far, distance, scale } = scenario;
  const logarithmic = renderer.logarithmicDepthBuffer;
  const camera = new THREE.PerspectiveCamera(55, WIDTH / HEIGHT, near, far);
  camera.coordinateSystem = renderer.coordinateSystem;
  camera.updateProjectionMatrix();
  // Matrix projection is independent of the library's inverse projection.
  const projectedDepth = new THREE.Vector3(0, 0, -distance).applyMatrix4(camera.projectionMatrix).z;
  const deviceDepth = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? projectedDepth : projectedDepth * 0.5 + 0.5;
  const depth = logarithmic ? Math.log(distance / near) / Math.log(far / near) : deviceDepth;
  const depthTexture = makeTexture(new Float32Array(WIDTH * HEIGHT).fill(depth), WIDTH, HEIGHT);
  const normalTexture = makeTexture(new Float32Array(scenario.encoded ? [0.5, 0.5, 1, 1] : [0, 0, 1, 1]), 1, 1, true);
  const aoSize = Math.round(WIDTH * scale);
  const aoData = Uint8Array.from({ length: aoSize * aoSize }, (_, i) =>
    ((i % aoSize) * 37 + Math.floor(i / aoSize) * 73) % 256);
  const aoTexture = makeTexture(aoData, aoSize, aoSize);
  aoTexture.minFilter = THREE.LinearFilter;
  aoTexture.magFilter = THREE.LinearFilter;
  const depthNode = texture(depthTexture);
  const normalNode = texture(normalTexture);
  const aoInput = texture(aoTexture);
  const ao = new GTVBAONode(depthNode, normalNode, camera, {
    resolutionScale: scale,
    useTemporalFiltering: false,
    normalEncoding: scenario.encoded ? "directionToColor" : "view",
    useDepthMips: scenario.mips ?? true,
    useDepthAwareUpsample: scenario.upsample ?? true,
  });
  const internals = ao as unknown as AoInternals;
  // Deliberately construct this before setup() sets the AO node's depth mode.
  if (internals._logarithmicDepthBuffer !== false) throw new Error("Expected unbuilt AO node");
  const actual = ao.createDepthAwareAoFromBuffers(aoInput, depthNode, normalNode, screenUV);
  const reference = aoInput.sample(screenUV).r;
  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(actual, reference, abs(actual.sub(reference)), 1);
  const quad = new THREE.QuadMesh(material);
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { type: THREE.FloatType, depthBuffer: false });
  try {
    // Populate the real AO prefilter/linear-depth MIPs without replacing their
    // shader math with a test implementation. The AO input itself is the fixture.
    reportProgress(`${logarithmic ? "log" : "normal"} / ${scenario.name}: AO setup`);
    ao.setup({ renderer, getSharedContext: () => ({}) } as never);
    reportProgress(`${scenario.name}: AO update`);
    internals.updateBefore({ renderer, frameId: 0 });
    renderer.setRenderTarget(target);
    reportProgress(`${scenario.name}: probe rendering`);
    quad.render(renderer);
    reportProgress(`${scenario.name}: probe rendered`);
    const pixels = await readFloatTarget(renderer, target);
    let squaredError = 0;
    let maxError = 0;
    const values = new Float32Array(WIDTH * HEIGHT);
    for (let i = 0; i < values.length; i++) {
      values[i] = pixels[i * 4];
      const error = Math.abs(values[i] - pixels[i * 4 + 1]);
      if (!Number.isFinite(error)) throw new Error(`Nonfinite output in ${scenario.name}`);
      squaredError += error * error;
      maxError = Math.max(maxError, error);
    }
    const digest = await crypto.subtle.digest("SHA-256", values.buffer);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const label = `${logarithmic ? "log" : "normal"} / ${scenario.name}`;
    if (scenario.name === "half" || scenario.name === "wide-range") showPixels(label, pixels);
    return { label, maxError, rmse: Math.sqrt(squaredError / values.length), hash, passed: maxError <= TOLERANCE };
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
    material.dispose();
    ao.dispose();
    aoTexture.dispose();
    depthTexture.dispose();
    normalTexture.dispose();
  }
}

async function run() {
  const results = [];
  for (const logarithmicDepthBuffer of [false, true]) {
    const renderer = new THREE.WebGPURenderer({ logarithmicDepthBuffer, antialias: false, forceWebGL });
    renderer.setPixelRatio(1);
    renderer.setSize(WIDTH, HEIGHT);
    reportProgress(`Renderer: initializing (${logarithmicDepthBuffer ? "log" : "normal"} depth)`);
    await renderer.init();
    reportProgress("Renderer: initialized");
    try {
      assertBackend(renderer);
      for (const scenario of scenarios) results.push(await runScenario(renderer, scenario));
    } finally {
      renderer.dispose();
    }
  }
  return { backend: requestedBackend, passed: results.every(result => result.passed), tolerance: TOLERANCE, results };
}

// Machine-readable completion for browser automation; a failed test remains
// visible on the page and never silently passes when the requested backend is unavailable.
const result = await run().catch(error => ({ passed: false, error: String(error) }));
Object.assign(window, { upsampleRegression: result });
document.querySelector("#status")!.textContent = "results" in result
  ? `${result.passed ? "PASS" : "FAIL"} — ${result.backend}\n` + result.results.map(entry =>
    `${entry.passed ? "PASS" : "FAIL"}  ${entry.label}: max error ${entry.maxError.toExponential(3)}`).join("\n")
  : result.error;
