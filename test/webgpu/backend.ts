import * as THREE from "three/webgpu";

export const forceWebGL = new URLSearchParams(location.search).get("backend") === "webgl";
export const requestedBackend = forceWebGL ? "WebGL2" : "WebGPU";

// Expose the last stages while a driver operation is pending. The bounded
// history distinguishes renderer setup, drawing, frame scheduling and readback.
const progress: string[] = [];
export function reportProgress(stage: string) {
  progress.push(stage);
  if (progress.length > 20) progress.shift();
  Object.assign(window, { regressionProgress: [...progress] });
  const status = document.querySelector("#status");
  if (status) status.textContent = `Running — ${requestedBackend}\n${progress.join("\n")}`;
}

export function assertBackend(renderer: THREE.WebGPURenderer) {
  const backend = renderer.backend as typeof renderer.backend & {
    isWebGPUBackend?: boolean; isWebGLBackend?: boolean;
  };
  if (forceWebGL ? backend.isWebGLBackend !== true : backend.isWebGPUBackend !== true) {
    throw new Error(`This regression requires the ${requestedBackend} backend`);
  }
  return requestedBackend;
}

// Normalize both backends to tightly packed, top-to-bottom RGBA32F pixels.
export async function readFloatTarget(renderer: THREE.WebGPURenderer, target: THREE.RenderTarget) {
  const { width, height } = target;
  reportProgress(`Readback ${width}×${height}: submitted`);
  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height) as Float32Array;
  reportProgress(`Readback ${width}×${height}: complete`);
  const webgpu = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem;
  // r184 WebGPU readback retains 256-byte row padding; GL readPixels is packed
  // and starts at the bottom row, unlike TSL's top-origin screenCoordinate.
  const rowStride = webgpu ? Math.ceil(width * 16 / 256) * 64 : width * 4;
  const packed = new Float32Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const sourceRow = webgpu ? row : height - row - 1;
    packed.set(pixels.subarray(sourceRow * rowStride, sourceRow * rowStride + width * 4), row * width * 4);
  }
  return packed;
}

export async function renderProbe(renderer: THREE.WebGPURenderer, node: THREE.Node, width: number, height = 1) {
  const material = new THREE.NodeMaterial();
  material.fragmentNode = node;
  const quad = new THREE.QuadMesh(material);
  const target = new THREE.RenderTarget(width, height, { type: THREE.FloatType, depthBuffer: false });
  try {
    renderer.setRenderTarget(target);
    reportProgress(`Probe ${width}×${height}: rendering`);
    quad.render(renderer);
    reportProgress(`Probe ${width}×${height}: rendered`);
    return await readFloatTarget(renderer, target);
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
    material.dispose();
  }
}
