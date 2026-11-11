import assert from "node:assert/strict";
import { PerspectiveCamera } from "three";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";

type Material = { version: number; addEventListener(type: "dispose", listener: () => void): void };
type Internals = {
  _material: Material;
  _fragmentContext: object | null;
  _materials: Map<string, Material>;
  depthNode: unknown;
};

// Simulates the state after setup(): variant changes now build and select
// per-variant materials instead of bumping the single placeholder material.
function createPostSetupNode() {
  const node = new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera());
  const internals = node as unknown as Internals;
  internals._fragmentContext = {};
  // The first post-setup refresh replaces the placeholder with a cached material.
  (node as unknown as { _refreshMaterialFragmentNode(): void })._refreshMaterialFragmentNode();
  const disposed = new Set<Material>();
  const track = (material: Material) => material.addEventListener("dispose", () => disposed.add(material));
  return { node, internals, disposed, track };
}

test("GTVBAONode reuses the earlier AO material when returning to a shader variant", () => {
  const { node, internals, disposed } = createPostSetupNode();
  const cosine = internals._material;
  const cosineVersion = cosine.version;

  node.sectorMeasure.value = "angle";
  const angle = internals._material;
  assert.notEqual(angle, cosine);

  node.sectorMeasure.value = "cosine";
  assert.equal(internals._material, cosine);
  assert.equal(cosine.version, cosineVersion);
  node.sectorMeasure.value = "angle";
  assert.equal(internals._material, angle);
  assert.equal(disposed.size, 0);

  node.dispose();
});

test("GTVBAONode shares the AO material between debug modes 0 and 1", () => {
  const { node, internals } = createPostSetupNode();
  const material = internals._material;
  const version = material.version;

  node.debugMode.value = 1;
  assert.equal(internals._material, material);
  node.debugMode.value = 0;
  assert.equal(internals._material, material);

  node.debugMode.value = 4;
  assert.notEqual(internals._material, material);
  assert.equal(material.version, version);

  // Returning from another variant under raw-AO debug still finds the same entry.
  node.debugMode.value = 1;
  assert.equal(internals._material, material);
  node.stepCount.value = 9;
  assert.notEqual(internals._material, material);
  node.stepCount.value = 8;
  assert.equal(internals._material, material);

  node.dispose();
});

test("GTVBAONode keeps at most eight AO materials and disposes the least recently used", () => {
  const { node, internals, disposed, track } = createPostSetupNode();
  const materials: Material[] = [];
  for (let steps = 4; steps < 12; steps += 1) {
    node.stepCount.value = steps;
    materials.push(internals._material);
    track(internals._material);
  }
  assert.equal(new Set(materials).size, 8);
  assert.equal(disposed.size, 0);

  // Touch the oldest so the second one becomes least recently used.
  node.stepCount.value = 4;
  assert.equal(internals._material, materials[0]);

  node.stepCount.value = 12;
  assert.equal(internals._materials.size, 8);
  assert.deepEqual([...disposed], [materials[1]]);
  assert.equal(disposed.has(internals._material), false);

  node.stepCount.value = 4;
  assert.equal(internals._material, materials[0]);
  assert.equal(disposed.has(materials[0]), false);

  node.dispose();
});

test("GTVBAONode rebuilds every cached AO material when its depth input changes", () => {
  const { node, internals, disposed, track } = createPostSetupNode();
  node.stepCount.value = 5;
  const first = internals._material;
  node.stepCount.value = 6;
  const second = internals._material;
  track(first);
  track(second);

  // Same inputs, new variant: nothing is disposed.
  node.stepCount.value = 7;
  assert.equal(disposed.size, 0);

  internals.depthNode = uniform(2);
  node.stepCount.value = 5;
  assert.deepEqual(new Set(disposed), new Set([first, second]));
  assert.notEqual(internals._material, first);
  assert.equal(internals._materials.size, 1);

  node.dispose();
});

test("GTVBAONode keeps cached AO materials unless a primitive context entry changes", () => {
  const { node, internals, disposed, track } = createPostSetupNode();
  const setContext = (context: object) => {
    internals._fragmentContext = context;
    node.stepCount.value = node.stepCount.value === 6 ? 4 : 6;
  };
  internals._fragmentContext = { flag: 1, closure: () => 0 };
  (node as unknown as { _refreshMaterialFragmentNode(): void })._refreshMaterialFragmentNode();
  const original = internals._material;
  track(original);

  // Shared contexts carry fresh closures and nodes on every build; they must not invalidate.
  setContext({ flag: 1, closure: () => 1, nested: {} });
  assert.equal(disposed.size, 0);
  setContext({ flag: 1, closure: () => 2, nested: { other: true }, extra: () => 3 });
  assert.equal(disposed.size, 0);
  node.stepCount.value = 8;
  assert.equal(internals._material, original);
  assert.equal(disposed.size, 0);

  setContext({ flag: 2, closure: () => 2 });
  assert.equal(disposed.has(original), true);

  node.dispose();
});

test("GTVBAONode disposes every cached AO material on disposal", () => {
  const { node, internals, disposed, track } = createPostSetupNode();
  const created: Material[] = [];
  for (const steps of [5, 6, 7]) {
    node.stepCount.value = steps;
    created.push(internals._material);
    track(internals._material);
  }

  node.dispose();
  assert.deepEqual(new Set(disposed), new Set(created));
});
