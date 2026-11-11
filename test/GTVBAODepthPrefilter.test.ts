import assert from "node:assert/strict";
import { PerspectiveCamera } from "three";
import type { ComputeNode } from "three/webgpu";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";

type MipTexture = { image: { width: number; height: number }; addEventListener(type: "dispose", listener: () => void): void };
type MipNode = { value: MipTexture };
type Prefilter = { compute(renderer: { compute(kernels: ComputeNode[]): void }): void };

function createNode() {
  return new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera());
}

function mipNodes(node: GTVBAONode) {
  return node.getDepthMipNodes() as unknown as MipNode[];
}

function mipSizes(node: GTVBAONode) {
  return mipNodes(node).map(({ value }) => [value.image.width, value.image.height]);
}

test("GTVBAONode allocates depth MIP textures only while depth MIPs are on", () => {
  const node = createNode();
  const placeholders = [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]];
  assert.deepEqual(mipSizes(node), placeholders);

  node.useDepthMips.value = false;
  node.setSize(640, 360);
  assert.deepEqual(mipSizes(node), placeholders);

  // Odd sizes round up at every level; the AO size follows resolutionScale.
  node.resolutionScale = 0.5;
  node.useDepthMips.value = true;
  node.setSize(321, 181);
  assert.deepEqual(mipSizes(node), [[161, 91], [81, 46], [41, 23], [21, 12], [11, 6]]);

  node.useDepthMips.value = false;
  node.setSize(321, 181);
  assert.deepEqual(mipSizes(node), placeholders);

  // The same size must reallocate after a release.
  node.useDepthMips.value = true;
  node.setSize(321, 181);
  assert.deepEqual(mipSizes(node), [[161, 91], [81, 46], [41, 23], [21, 12], [11, 6]]);

  node.dispose();
});

test("GTVBAONode disposes allocated depth MIP textures when depth MIPs turn off", () => {
  const node = createNode();
  node.setSize(64, 32);
  const allocated = mipNodes(node).map(({ value }) => value);
  const disposed = new Set<MipTexture>();
  for (const texture of allocated) texture.addEventListener("dispose", () => disposed.add(texture));

  node.useDepthMips.value = false;
  node.setSize(64, 32);
  assert.equal(disposed.size, allocated.length);

  // Releasing again with nothing allocated disposes nothing further.
  const placeholders = mipNodes(node).map(({ value }) => value);
  for (const texture of placeholders) texture.addEventListener("dispose", () => disposed.add(texture));
  node.setSize(32, 16);
  assert.equal(disposed.size, allocated.length);

  node.dispose();
  assert.equal(disposed.size, allocated.length + placeholders.length);
});

test("GTVBAONode runs both depth prefilter kernels in one compute call with dispatch sizes", () => {
  const node = createNode();
  const prefilter = (node as unknown as { _depthPrefilter: Prefilter })._depthPrefilter;
  const calls: { args: unknown[]; dispatchSizes: unknown[] }[] = [];
  const renderer = {
    compute(...args: unknown[]) {
      const kernels = args[0] as (ComputeNode & { dispatchSize: number[] })[];
      calls.push({ args, dispatchSizes: kernels.map((kernel) => [...kernel.dispatchSize]) });
    },
  };

  // 64x32 AO: level 1 has 32x16 = 512 texels, level 2 has 16x8 = 128.
  node.setSize(64, 32);
  prefilter.compute(renderer as never);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.length, 1);
  assert.deepEqual(calls[0].dispatchSizes, [[8, 1, 1], [2, 1, 1]]);

  // 8200x4100 AO: level 1 has 4100 * 2050 = 8,405,000 texels = 131,329
  // workgroups, above the 65,535 per-dimension limit; level 2 has 2,101,250
  // texels = 32,833 workgroups. Textures are never allocated without a renderer.
  node.setSize(8200, 4100);
  prefilter.compute(renderer as never);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].dispatchSizes, [[65535, 3, 1], [32833, 1, 1]]);

  node.dispose();
});
