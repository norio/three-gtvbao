import * as THREE from "three/webgpu";
import type { Node } from "three/webgpu";
import {
  builtinAOContext,
  mrt,
  normalView,
  pass,
  positionView,
  screenUV,
  vec3,
  vec4,
  velocity,
} from "three/tsl";
import { traa } from "three/examples/jsm/tsl/display/TRAANode.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  gtvbao,
  gtvbaoDenoise,
  gtvbaoTemporal,
  applyGtvbaoPreset,
  createPassthroughAoContext,
  isGtvbaoDebugEnabled,
  isGtvbaoTemporalJitterDebug,
  renderPassAfter,
  GTVBAO_PRESETS,
  type GTVBAOPresetName,
} from "../src/index.js";
import { createScene } from "./scene.js";
import { createGui } from "./gui.js";
import { createFpsStats } from "./stats.js";
import { createExampleCamera, updateCameraProjection } from "./camera.js";
import { createPresentation, setCameraView, updatePresentation } from "./presentation.js";

type PassNode = ReturnType<typeof pass>;
type TraaNode = ReturnType<typeof traa> & { setSize(width: number, height: number): void };
type AoSource = "off" | "raw" | "denoised" | "accumulated" | "accumulatedDenoised";

export type ExamplePresetName = GTVBAOPresetName | "Showcase";

export interface ViewSettings {
  preset: ExamplePresetName | "Custom";
  aoEnabled: boolean;
  denoise: boolean;
  accumulate: boolean;
  temporal: boolean;
  traa: boolean;
  aoOnly: boolean;
  showFps: boolean;
  autoLighting: boolean;
}

const SHOWCASE_UPSAMPLE_JITTER = 4;

const params = new URLSearchParams(window.location.search);
// A hidden window reports 0x0; use a square aspect until the first real resize.
const viewportAspect = () => (window.innerWidth > 0 && window.innerHeight > 0 ? window.innerWidth / window.innerHeight : 1);
const forceWebGL = params.get("backend") === "webgl";
const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL });
// Keep the full-resolution AO affordable on very dense displays.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);
try {
  await renderer.init();
} catch (error) {
  const status = document.querySelector("#render-status");
  if (status) status.textContent = "Unable to initialize WebGPU / WebGL2.";
  throw error;
}
const backendName = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? "WEBGPU" : "WEBGL2";

const camera = createExampleCamera(
  params.get("camera") === "orthographic" ? "orthographic" : "perspective",
  viewportAspect(),
);
camera.position.set(11, 9, 14);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.minDistance = 4;
controls.maxDistance = 42;
controls.minZoom = 0.35;
controls.maxZoom = 5;
controls.maxPolarAngle = Math.PI / 2 - 0.06;
controls.autoRotateSpeed = 0.4;
setCameraView("overview", camera, controls);

const { scene, sun, update: updateScene } = createScene();
const timer = new THREE.Timer();
timer.connect(document);

// 1. An opaque pre-pass provides depth, encoded view-space normals and velocity.
// The encoding is written inline because three renamed its helper between
// revisions; it is the inverse of what the AO nodes apply for
// normalEncoding "directionToColor" (normal * 2 - 1).
const prePass = pass(scene, camera);
prePass.transparent = false;
prePass.setMRT(mrt({ output: normalView.mul(0.5).add(0.5), velocity }));
prePass.contextNode = createPassthroughAoContext();
const preNormal = prePass.getTextureNode("output");
const preDepth = prePass.getTextureNode("depth");
const preVelocity = prePass.getTextureNode("velocity");
// 8-bit normals halve the normal attachment's bandwidth. Set the type after
// velocity is cloned from output so TRAA keeps its half-float velocity texture.
prePass.getTexture("output").type = THREE.UnsignedByteType;

// 2. The AO reads the pre-pass; denoising can read raw or accumulated AO.
const aoNode = gtvbao(preDepth, preNormal, camera, { normalEncoding: "directionToColor" });
const denoiseNode = gtvbaoDenoise(aoNode.getTextureNode(), preDepth, preNormal, camera, {
  linearDepthSource: aoNode,
  normalEncoding: "directionToColor",
});
const temporalNode = gtvbaoTemporal(aoNode.getTextureNode(), preVelocity, aoNode);
const denoiseAccumulatedNode = gtvbaoDenoise(temporalNode.getTextureNode(), preDepth, preNormal, camera, {
  linearDepthSource: aoNode,
  normalEncoding: "directionToColor",
});
// Share uniforms so presets and GUI edits tune both denoisers before shader builds.
denoiseAccumulatedNode.radius = denoiseNode.radius;
denoiseAccumulatedNode.lumaPhi = denoiseNode.lumaPhi;
denoiseAccumulatedNode.depthPhi = denoiseNode.depthPhi;
denoiseAccumulatedNode.normalPhi = denoiseNode.normalPhi;
denoiseAccumulatedNode.index = denoiseNode.index;
renderPassAfter(aoNode, prePass);
renderPassAfter(denoiseNode, aoNode);
renderPassAfter(temporalNode, aoNode);
renderPassAfter(denoiseAccumulatedNode, temporalNode);

const aoTextureOf = (source: Exclude<AoSource, "off">) =>
  source === "raw" ? aoNode.getTextureNode()
    : source === "accumulated" ? temporalNode.getTextureNode()
      : source === "accumulatedDenoised" ? denoiseAccumulatedNode.getTextureNode() : denoiseNode.getTextureNode();

// 3. One lit scene pass per AO source. The AO reaches every material's
// indirect lighting through the pass context, sampled with the depth-aware
// upsample at the fragment's own position and normal.
const litPasses = new Map<AoSource, PassNode>();
const getLitPass = (source: AoSource) => {
  let litPass = litPasses.get(source);
  if (litPass === undefined) {
    litPass = pass(scene, camera);
    if (source !== "off") {
      renderPassAfter(litPass, prePass);
      litPass.contextNode = builtinAOContext(
        aoNode.createDepthAwareAo(aoTextureOf(source), {
          screenUv: screenUV,
          viewPosition: positionView,
          viewNormal: normalView,
        })
      );
    }
    litPasses.set(source, litPass);
  }
  return litPass;
};

// AO-only view: the AO exactly as the lit pass reads it, upsample included.
const createAoOnlyNode = (source: Exclude<AoSource, "off">) =>
  vec4(
    vec3(
      aoNode.createDepthAwareAoFromBuffers(aoTextureOf(source), preDepth, preNormal, screenUV)
    ),
    1
  );

// 4. Output variants are built once and cached; TRAA keeps one history each.
const pipeline = new THREE.RenderPipeline(renderer);
const outputNodes = new Map<string, Node<"vec4">>();
const traaNodes = new Map<string, TraaNode>();

const buildOutputNode = (key: string, source: AoSource, aoOnly: boolean, useTraa: boolean) => {
  const input: Node<"vec4"> | PassNode = aoOnly
    ? createAoOnlyNode(source === "off" ? "raw" : source)
    : getLitPass(source);
  if (!useTraa) return "isPassNode" in input ? input.getTextureNode() : input;
  const traaNode = traa(input, preDepth, preVelocity, camera) as TraaNode;
  if (aoOnly) {
    // TRAA wraps the AO expression in an RTT. Render it before TRAA reads its
    // size: the initial null dimensions otherwise poison the camera aspect.
    // The resolve also samples this RTT, so update it only once per frame.
    traaNode.beautyNode.updateBeforeType = THREE.NodeUpdateType.FRAME;
    renderPassAfter(traaNode, traaNode.beautyNode);
  }
  traaNodes.set(key, traaNode);
  return traaNode as unknown as Node<"vec4">;
};

const resetTraaHistory = () => {
  for (const traaNode of traaNodes.values()) traaNode.setSize(1, 1);
  temporalNode.reset();
};

const settings: ViewSettings = {
  preset: "Showcase",
  aoEnabled: true,
  denoise: false,
  accumulate: true,
  temporal: true,
  traa: true,
  aoOnly: false,
  showFps: true,
  autoLighting: false,
};
const stats = createFpsStats();
const syncStats = () => { stats.dom.hidden = !settings.showFps; };
syncStats();

const syncOutput = () => {
  const source: AoSource = !settings.aoEnabled ? "off"
    : settings.denoise ? (settings.accumulate ? "accumulatedDenoised" : "denoised")
      : settings.accumulate ? "accumulated" : "raw";
  const debug = isGtvbaoDebugEnabled(aoNode.debugMode.value);
  const aoOnly = settings.aoOnly || debug;
  const useTraa = settings.traa && !debug;
  const key = debug ? "debug" : `${aoOnly ? "ao" : "lit"}|${source}|${useTraa ? "traa" : "direct"}`;
  let outputNode = outputNodes.get(key);
  if (outputNode === undefined) {
    // Diagnostic RGB is the raw AO target: preserve every channel and avoid
    // denoising, AO-specific upsampling, and temporal accumulation.
    outputNode = debug
      ? aoNode.getTextureNode().sample(screenUV)
      : buildOutputNode(key, source, aoOnly, useTraa);
    outputNodes.set(key, outputNode);
  }
  // Per-frame jitter converges through TRAA or AO accumulation; otherwise
  // keep the sampling pattern fixed (and lean on the denoiser). The jitter debug
  // view shows the pattern itself, so it keeps rotating regardless.
  aoNode.useTemporalFiltering =
    settings.temporal && (
      useTraa || source === "accumulated" || source === "accumulatedDenoised" || isGtvbaoTemporalJitterDebug(aoNode.debugMode.value)
    );
  denoiseNode.useTemporalDenoiseRotation = settings.temporal && useTraa && settings.denoise;
  denoiseAccumulatedNode.useTemporalDenoiseRotation = denoiseNode.useTemporalDenoiseRotation;
  if (denoiseNode.noiseNode !== null) denoiseAccumulatedNode.noiseNode = denoiseNode.noiseNode;
  updatePresentation(settings, aoNode, backendName);
  if (pipeline.outputNode === outputNode) return;
  pipeline.outputNode = outputNode;
  pipeline.needsUpdate = true;
  // Keep cached lit targets allocated: shrinking them disposes attachments
  // still referenced by cached material bindings when that view returns.
  // TRAA history can be resized safely and is cleared on each output change.
  resetTraaHistory();
};

const applyPreset = (name: ExamplePresetName) => {
  // Showcase is the example's default: Balanced (half resolution with temporal
  // accumulation) plus a wide upsample jitter.
  const preset = applyGtvbaoPreset(aoNode, name === "Showcase" ? GTVBAO_PRESETS.Balanced : name, denoiseNode);
  aoNode.upsampleJitter = name === "Showcase" ? SHOWCASE_UPSAMPLE_JITTER : 0;
  settings.preset = name;
  settings.denoise = preset.denoise;
  settings.accumulate = preset.accumulate;
  settings.temporal = preset.temporal;
  syncOutput();
};

// A shader variant change (slice/step count, sector measure, ...) rebuilds
// the AO material; the pipeline has to pick the new program up.
aoNode.setVariantChangeCallback(() => {
  pipeline.needsUpdate = true;
  resetTraaHistory();
});

applyPreset("Showcase");
const gui = createGui({ renderer, sun, aoNode, denoiseNode, temporalNode, settings, applyPreset, syncOutput, resetTraaHistory, syncStats });
const updateCamera = createPresentation({ camera, controls, gui, settings, aoNode, syncOutput });

window.addEventListener("resize", () => {
  updateCameraProjection(camera, viewportAspect());
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  timer.update();
  updateScene(timer.getDelta(), settings.autoLighting);
  updateCamera(timer.getDelta());
  pipeline.render();
  if (settings.showFps) stats.update();
});

// The GPU regression page drives this same graph with a frozen scene.
export { renderer, scene, camera, controls, aoNode, denoiseNode, denoiseAccumulatedNode, temporalNode, prePass, pipeline, settings, syncOutput };
