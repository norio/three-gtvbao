import * as THREE from "three/webgpu";
import { builtinAOContext, float, pass, positionView, normalView, screenUV, texture } from "three/tsl";
import { gtvbao } from "../../src/index.js";
import { assertBackend, forceWebGL, readFloatTarget } from "./backend.js";

const size = 64;
const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL });
renderer.setPixelRatio(1);
renderer.setSize(size, size);
await renderer.init();
assertBackend(renderer);
const shaders: string[] = [];
const backend = renderer.backend as typeof renderer.backend & {
  createRenderPipeline(object: { material: THREE.Material; getNodeBuilderState(): { fragmentShader: string } }, promises?: unknown): unknown;
};
const createPipeline = backend.createRenderPipeline.bind(backend);
backend.createRenderPipeline = (object, promises) => {
  if (object.material === material) shaders.push(object.getNodeBuilderState().fragmentShader);
  return createPipeline(object, promises);
};
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.z = 4;
const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(2, 3, 4);
scene.add(sun);
const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material));
const aoTexture = new THREE.DataTexture(new Uint8Array(size * size).fill(153), size, size, THREE.RedFormat);
aoTexture.needsUpdate = true;
const depthTexture = new THREE.DataTexture(new Float32Array(size * size).fill(0.98), size, size, THREE.RedFormat, THREE.FloatType);
depthTexture.needsUpdate = true;
const ao = gtvbao(texture(depthTexture), null, camera, { resolutionScale: 1, useTemporalFiltering: false });
const actual = ao.createDepthAwareAo(texture(aoTexture), { screenUv: screenUV, viewPosition: positionView, viewNormal: normalView });
const target = new THREE.RenderTarget(size, size, { type: THREE.FloatType, depthBuffer: false });
async function capture(value: THREE.Node) {
  const lit = pass(scene, camera);
  lit.contextNode = builtinAOContext(value);
  const pipeline = new THREE.RenderPipeline(renderer, lit.getTextureNode());
  pipeline.outputColorTransform = false;
  renderer.setRenderTarget(target);
  pipeline.render();
  const pixels = await readFloatTarget(renderer, target);
  pipeline.dispose();
  lit.dispose();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.putImageData(new ImageData(Uint8ClampedArray.from(pixels, x => x * 255), size, size), 0, 0);
  document.querySelector("#images")!.append(canvas);
  return pixels;
}
try {
  const observed = await capture(actual);
  const reference = await capture(float(153 / 255));
  let maxError = 0;
  for (let i = 0; i < observed.length; i++) maxError = Math.max(maxError, Math.abs(observed[i] - reference[i]));
  const center = ((size / 2) * size + size / 2) * 4;
  const referenceCenter = reference[center];
  const result = {
    revision: THREE.REVISION, backend: assertBackend(renderer),
    passed: observed.every(Number.isFinite) && reference.every(Number.isFinite) && referenceCenter > 0.1 && maxError < 2e-5,
    maxError, referenceCenter,
  };
  Object.assign(window, { lightingRegression: result, lightingShaders: shaders });
  if (new URLSearchParams(location.search).has("shaders")) {
    const shaderText = document.createElement("pre");
    shaderText.id = "shaders";
    shaderText.textContent = shaders.join("\n// REFERENCE\n");
    document.body.append(shaderText);
  }
  document.querySelector("#status")!.textContent = JSON.stringify(result, null, 2);
} catch (error) {
  const result = { passed: false, error: String(error) };
  Object.assign(window, { lightingRegression: result });
  document.querySelector("#status")!.textContent = JSON.stringify(result);
} finally {
  renderer.setRenderTarget(null);
  target.dispose(); ao.dispose(); aoTexture.dispose(); depthTexture.dispose(); material.dispose();
  scene.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
  backend.createRenderPipeline = createPipeline;
  renderer.dispose();
}
