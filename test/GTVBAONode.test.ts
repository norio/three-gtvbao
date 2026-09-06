import assert from "node:assert/strict";
import { LinearFilter, PerspectiveCamera, RedFormat, RGBAFormat } from "three";
import type { ComputeNode } from "three/webgpu";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";

test("GTVBAONode variant values invalidate the shader variant", () => {
  const node = createTestGtvbaoNode();
  const material = getInternalMaterial(node);
  let invalidations = 0;
  node.setVariantChangeCallback(() => {
    invalidations += 1;
  });

  const initialNodeVersion = node.version;
  const initialMaterialVersion = material.version;
  node.stepCount.value = 12;

  assert.equal(node.stepCount.value, 12);
  assert.equal(invalidations, 1);
  assert.equal(node.version, initialNodeVersion + 1);
  assert.equal(material.version, initialMaterialVersion + 1);

  node.stepCount.value = 12;
  node.radius.value = 4;

  assert.equal(invalidations, 1);

  // expFactor and aoIntensity are uniforms with a build-time fast path at
  // their defaults; only crossing that boundary rebuilds the shader.
  node.expFactor.value = 3;

  assert.equal(invalidations, 2);
  assert.equal(node.version, initialNodeVersion + 2);
  assert.equal(material.version, initialMaterialVersion + 2);

  node.expFactor.value = 4;

  assert.equal(invalidations, 2);

  node.expFactor.value = 2;

  assert.equal(invalidations, 3);

  node.aoIntensity.value = 2;

  assert.equal(invalidations, 4);

  node.aoIntensity.value = 3;

  assert.equal(invalidations, 4);

  node.aoIntensity.value = 1;

  assert.equal(invalidations, 5);
  assert.equal(node.version, initialNodeVersion + 5);
  assert.equal(material.version, initialMaterialVersion + 5);

  node.batchVariantChanges(() => {
    node.stepCount.value = 10;
    node.usePerspectiveCorrectSlice.value = false;
  });

  assert.equal(invalidations, 6);
  assert.equal(node.version, initialNodeVersion + 6);
  assert.equal(material.version, initialMaterialVersion + 6);

  // Raw AO debug only switches the render target; the shader is unchanged.
  const versionBeforeRawDebug = node.version;
  const materialVersionBeforeRawDebug = material.version;
  node.debugMode.value = 1;

  assert.equal(node.debugMode.value, 1);
  assert.equal(invalidations, 7);
  assert.equal(node.version, versionBeforeRawDebug);
  assert.equal(material.version, materialVersionBeforeRawDebug);

  node.debugMode.value = 5;

  assert.equal(invalidations, 8);
  assert.equal(node.version, initialNodeVersion + 7);
  assert.equal(material.version, initialMaterialVersion + 7);

  node.debugMode.value = 4;

  assert.equal(invalidations, 9);
  assert.equal(node.version, initialNodeVersion + 8);

  // Out-of-range values clamp to the variant limits.
  node.sliceCount.value = 99;
  node.debugMode.value = -1;

  assert.equal(node.sliceCount.value, 8);
  assert.equal(node.debugMode.value, 0);
  assert.equal(invalidations, 11);
  assert.equal(node.version, initialNodeVersion + 10);
  assert.equal(material.version, initialMaterialVersion + 10);

  node.dispose();
});

test("GTVBAONode refreshes the internal AO material on sector measure changes", () => {
  const node = createTestGtvbaoNode();
  const materialVersion = getInternalMaterial(node).version;
  const fragmentRefreshes = installMaterialFragmentRefreshProbe(node);

  node.sectorMeasure.value = "angle";

  assert.deepEqual(fragmentRefreshes.consume(), ["angle"]);
  assert.equal(getInternalMaterial(node).version, materialVersion + 1);
  // Unknown values fall back to the cosine measure.
  (node.sectorMeasure as { value: unknown }).value = "bogus";
  assert.equal(node.sectorMeasure.value, "cosine");

  node.dispose();
});

test("GTVBAONode only upsamples by depth at reduced resolution with depth MIPs", () => {
  const node = createTestGtvbaoNode();

  assert.equal(node.useDepthAwareUpsample, true);
  assert.equal(node.isDepthAwareUpsampleActive(), false);
  node.resolutionScale = 0.5;
  assert.equal(node.isDepthAwareUpsampleActive(), true);
  node.useDepthMips.value = false;
  assert.equal(node.isDepthAwareUpsampleActive(), false);
  node.useDepthMips.value = true;
  node.useDepthAwareUpsample = false;
  assert.equal(node.isDepthAwareUpsampleActive(), false);

  node.dispose();
});

test("GTVBAONode switches compact AO and debug render targets", () => {
  const node = createTestGtvbaoNode();
  const internals = getGtvbaoRenderTargetInternals(node);

  assert.equal(internals._aoRenderTarget.texture.format, RedFormat);
  assert.equal(internals._debugRenderTarget.texture.format, RGBAFormat);
  assert.equal(internals._aoRenderTarget.texture.minFilter, LinearFilter);
  assert.equal(internals._aoRenderTarget.texture.magFilter, LinearFilter);

  node.resolutionScale = 0.5;
  node.setSize(320, 180);

  assert.equal(internals._aoRenderTarget.width, 160);
  assert.equal(internals._aoRenderTarget.height, 90);
  assert.equal(internals._debugRenderTarget.width, 1);
  assert.equal(internals._debugRenderTarget.height, 1);

  node.debugMode.value = 2;
  node.setSize(320, 180);

  assert.equal(internals._debugRenderTarget.width, 160);
  assert.equal(internals._debugRenderTarget.height, 90);
  assert.equal(internals._aoRenderTarget.width, 1);
  assert.equal(internals._aoRenderTarget.height, 1);

  node.debugMode.value = 0;
  node.setSize(640, 360);

  assert.equal(internals._aoRenderTarget.width, 320);
  assert.equal(internals._aoRenderTarget.height, 180);
  assert.equal(internals._debugRenderTarget.width, 1);
  assert.equal(internals._debugRenderTarget.height, 1);

  node.dispose();
});

test("GTVBAONode releases depth kernels on depth-mode changes and disposal", () => {
  const node = createTestGtvbaoNode();
  const { _depthPrefilter: prefilter } = node as unknown as {
    _depthPrefilter: {
      compute(renderer: { compute(kernel: ComputeNode): void }): void;
      setLogarithmicDepthBuffer(value: boolean): void;
    };
  };
  const liveKernels = new Set<ComputeNode>();
  const renderer = {
    compute(kernel: ComputeNode) {
      if (liveKernels.has(kernel)) return;
      liveKernels.add(kernel);
      kernel.addEventListener("dispose", () => liveKernels.delete(kernel));
    },
  };
  node.setSize(64, 32);
  prefilter.compute(renderer);
  assert.equal(liveKernels.size, 2);

  prefilter.setLogarithmicDepthBuffer(false);
  assert.equal(liveKernels.size, 2);

  prefilter.setLogarithmicDepthBuffer(true);
  assert.equal(liveKernels.size, 0);

  prefilter.compute(renderer);
  assert.equal(liveKernels.size, 2);

  node.dispose();
  assert.equal(liveKernels.size, 0);
});

function createTestGtvbaoNode() {
  return new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera());
}

function getInternalMaterial(node: GTVBAONode) {
  return (node as unknown as { _material: { version: number } })._material;
}

function installMaterialFragmentRefreshProbe(node: GTVBAONode) {
  const internals = node as unknown as {
    _refreshMaterialFragmentNode(): void;
    _fragmentContext: object | null;
  };
  const refreshes: string[] = [];
  const original = internals._refreshMaterialFragmentNode.bind(node);
  // Simulate a post-setup() state so the real refresh rebuilds the fragment node.
  internals._fragmentContext = {};
  internals._refreshMaterialFragmentNode = () => {
    refreshes.push(node.sectorMeasure.value);
    original();
  };
  return {
    consume() {
      const current = [...refreshes];
      refreshes.length = 0;
      return current;
    },
  };
}

function getGtvbaoRenderTargetInternals(node: GTVBAONode) {
  return node as unknown as {
    _aoRenderTarget: {
      height: number;
      texture: { format: number; magFilter: number; minFilter: number };
      width: number;
    };
    _debugRenderTarget: {
      height: number;
      texture: { format: number };
      width: number;
    };
  };
}
