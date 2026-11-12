import * as THREE from "three/webgpu";
import { screenUV, texture } from "three/tsl";
import { GTVBAONode, gtvbaoTemporal, type GTVBAOTemporalNode } from "../../src/index.js";
import { readFloatTarget } from "./backend.js";

export const SIZE = 16;
export const COUNT = SIZE * SIZE;
const NEAR = 0.1;
const FAR = 100;

export type RigOptions = {
  orthographic?: boolean;
  /** Derive normals from depth instead of supplying a normal buffer. */
  depthNormal?: boolean;
  blend?: number;
  /** Large by default so the neighborhood clamp does not hide what a case tests. */
  clampSigma?: number;
  parallaxBlend?: number;
};

export type Texels = { ao: Float32Array; depth: Float32Array; count: Float32Array };

function dataTexture(data: Float32Array, width: number, height: number, format: THREE.PixelFormat) {
  const result = new THREE.DataTexture(data, width, height, format, THREE.FloatType);
  result.needsUpdate = true;
  return result;
}

/**
 * One GTVBAOTemporalNode fed by synthetic AO, depth and velocity textures at the
 * same resolution. The node is driven through its real setup() and updateBefore();
 * its output is read back through a probe that samples the resolve texture.
 */
export class Rig {
  readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  readonly temporal: GTVBAOTemporalNode;
  private readonly ao: GTVBAONode;
  private readonly aoData = new Float32Array(COUNT);
  private readonly depthData = new Float32Array(COUNT);
  private readonly velocityData = new Float32Array(COUNT * 4);
  private readonly textures: THREE.DataTexture[];
  private readonly probeMaterial = new THREE.NodeMaterial();
  private readonly probeTarget = new THREE.RenderTarget(SIZE, SIZE, { type: THREE.FloatType, depthBuffer: false });
  private readonly dirty = new Set<THREE.DataTexture>();
  private readonly orthographic: boolean;

  constructor(private readonly renderer: THREE.WebGPURenderer, options: RigOptions = {}) {
    this.orthographic = options.orthographic === true;
    this.camera = this.orthographic
      ? new THREE.OrthographicCamera(-4, 4, 4, -4, NEAR, FAR)
      : new THREE.PerspectiveCamera(55, 1, NEAR, FAR);
    this.camera.coordinateSystem = renderer.coordinateSystem;
    this.camera.updateProjectionMatrix();
    // A rotated, offset pose: pure translations commute and would hide a wrong matrix order.
    this.camera.position.set(1, 0.5, 2);
    this.camera.rotation.set(0.1, 1, 0);
    this.camera.updateMatrixWorld(true);
    const aoTexture = dataTexture(this.aoData, SIZE, SIZE, THREE.RedFormat);
    const depthTexture = dataTexture(this.depthData, SIZE, SIZE, THREE.RedFormat);
    const velocityTexture = dataTexture(this.velocityData, SIZE, SIZE, THREE.RGBAFormat);
    const normalTexture = dataTexture(new Float32Array([0, 0, 1, 1]), 1, 1, THREE.RGBAFormat);
    this.textures = [aoTexture, depthTexture, velocityTexture, normalTexture];
    this.ao = new GTVBAONode(texture(depthTexture), options.depthNormal ? null : texture(normalTexture), this.camera, {
      resolutionScale: 1, useDepthMips: false, useTemporalFiltering: false, normalEncoding: "view",
    });
    // Only the projection scale used for the plane tolerance depends on this.
    this.ao.setSize(SIZE, SIZE);
    this.temporal = gtvbaoTemporal(texture(aoTexture), texture(velocityTexture), this.ao, {
      blend: options.blend, clampSigma: options.clampSigma ?? 1000, parallaxBlend: options.parallaxBlend ?? 0,
    });
    this.temporal.setup({ renderer, getSharedContext: () => ({}) } as never);
    this.probeMaterial.fragmentNode = texture(this.temporal.getTextureNode().value as THREE.Texture).sample(screenUV);
  }

  setAo(value: (x: number, y: number) => number) {
    this.fill(this.aoData, 1, (x, y) => [value(x, y)], 0);
  }

  /** View-space distance of the (fronto-parallel) surface at each texel. */
  setDistance(value: number | ((x: number, y: number) => number)) {
    const distanceAt = typeof value === "number" ? () => value : value;
    this.fill(this.depthData, 1, (x, y) => [this.rawDepth(distanceAt(x, y))], 1);
  }

  /** Velocity as three's velocity buffer stores it: current minus previous NDC, Y up. */
  setVelocity(value: (x: number, y: number) => [number, number]) {
    this.fill(this.velocityData, 4, (x, y) => [...value(x, y), 0, 1], 2);
  }

  /** Moves the camera and returns its previous world matrix. */
  moveCamera(move: (camera: THREE.Camera) => void) {
    const previous = this.camera.matrixWorld.clone();
    move(this.camera);
    this.camera.updateMatrixWorld(true);
    return previous;
  }

  /**
   * Velocity of a fronto-parallel surface at `distance` that stayed fixed in the
   * world while the camera moved from `previousWorld` to its current pose,
   * computed from the camera matrices only (perspective).
   */
  motionSince(previousWorld: THREE.Matrix4, distance: (x: number, y: number) => number) {
    const projection = this.camera.projectionMatrix;
    const previousInverse = previousWorld.clone().invert();
    return (x: number, y: number): [number, number] => {
      const ndcX = ((x + 0.5) * 2) / SIZE - 1;
      const ndcY = 1 - ((y + 0.5) * 2) / SIZE;
      const d = distance(x, y);
      const view = new THREE.Vector3((ndcX * d) / projection.elements[0], (ndcY * d) / projection.elements[5], -d);
      const before = view.applyMatrix4(this.camera.matrixWorld).applyMatrix4(previousInverse).applyMatrix4(projection);
      return [ndcX - before.x, ndcY - before.y];
    };
  }

  step(frameId: number) {
    for (const value of this.dirty) value.needsUpdate = true;
    this.dirty.clear();
    this.temporal.updateBefore({ renderer: this.renderer, frameId } as never);
  }

  async read(): Promise<Texels> {
    this.renderer.setRenderTarget(this.probeTarget);
    new THREE.QuadMesh(this.probeMaterial).render(this.renderer);
    const pixels = await readFloatTarget(this.renderer, this.probeTarget);
    const channel = (index: number) => Float32Array.from({ length: COUNT }, (_, i) => pixels[i * 4 + index]);
    this.renderer.setRenderTarget(null);
    return { ao: channel(0), depth: channel(1), count: channel(2) };
  }

  dispose() {
    this.temporal.dispose();
    this.ao.dispose();
    this.probeMaterial.dispose();
    this.probeTarget.dispose();
    for (const value of this.textures) value.dispose();
  }

  private fill(target: Float32Array, stride: number, value: (x: number, y: number) => number[], textureIndex: number) {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) target.set(value(x, y), (y * SIZE + x) * stride);
    }
    this.dirty.add(this.textures[textureIndex]);
  }

  private rawDepth(distance: number) {
    const projected = new THREE.Vector3(0, 0, -distance).applyMatrix4(this.camera.projectionMatrix).z;
    const device = this.renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? projected : projected * 0.5 + 0.5;
    return this.renderer.logarithmicDepthBuffer && !this.orthographic
      ? Math.log(distance / NEAR) / Math.log(FAR / NEAR)
      : device;
  }
}
