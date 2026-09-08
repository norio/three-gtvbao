import assert from "node:assert/strict";
import { DataTexture, OrthographicCamera } from "three";
import { texture } from "three/tsl";
import { test } from "vitest";
import { GTVBAONode, GTVBAODenoiseNode, gtvbao, gtvbaoDenoise } from "../src/index.js";

for (const near of [0, 0.1]) test(`orthographic public APIs track zoom without resize (near ${near})`, () => {
  const camera = new OrthographicCamera(-4, 4, 3, -3, near, 100);
  const source = new DataTexture(new Uint8Array(4), 1, 1);
  const input = texture(source);
  // Keep these calls typed: they cover both constructors and public factories.
  const nodes = [new GTVBAONode(input, null, camera), gtvbao(input, null, camera)];
  const denoisers = [
    new GTVBAODenoiseNode(input, input, null, camera),
    gtvbaoDenoise(input, input, null, camera),
  ];
  try {
    for (const node of nodes) {
      node.setSize(320, 180);
      const scale = (node as unknown as { _halfProjScale: { value: number } })._halfProjScale;
      const initial = scale.value;
      assert.ok(Number.isFinite(initial) && initial > 0);
      camera.zoom = 2;
      camera.updateProjectionMatrix();
      node.setSize(320, 180);
      assert.equal(scale.value, initial * 2, "camera zoom doubles projected world radius at unchanged target size");
      camera.top = 6;
      camera.bottom = -6;
      camera.updateProjectionMatrix();
      node.setSize(320, 180);
      assert.equal(scale.value, initial, "doubling view height restores the original projected radius");
      camera.zoom = 1;
      camera.top = 3;
      camera.bottom = -3;
      camera.updateProjectionMatrix();
    }
  } finally {
    for (const node of [...nodes, ...denoisers]) node.dispose();
    source.dispose();
  }
});
