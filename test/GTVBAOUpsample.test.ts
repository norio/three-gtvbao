import assert from "node:assert/strict";
import {
  DataTexture,
  NodeBuilder,
  PerspectiveCamera,
  OrthographicCamera,
  ReferenceNode,
  type Node,
} from "three/webgpu";
import { texture, vec2 } from "three/tsl";
import { test } from "vitest";
import { gtvbao } from "../src/index.js";

// The real setup stage needs no GPU backend. @types/three still marks this
// constructor abstract and omits flowBuildStage(), so describe that API here.
const SetupNodeBuilder = NodeBuilder as unknown as {
  new (
    object: null,
    renderer: { readonly logarithmicDepthBuffer: boolean },
    parser: null
  ): NodeBuilder & { flowBuildStage(node: Node, stage: "setup"): unknown };
};

for (const orthographic of [false, true]) test(`buffer upsampling chooses depth decoding at shader build before AO setup (${orthographic ? "orthographic" : "perspective"})`, () => {
  const textures = Array.from(
    { length: 3 },
    () => new DataTexture(new Uint8Array(4), 1, 1)
  );
  const [depthTexture, normalTexture, aoTexture] = textures.map((value) => texture(value));
  const camera = orthographic
    ? new OrthographicCamera(-4, 4, 4, -4, 0.1, 1000)
    : new PerspectiveCamera(55, 1, 0.1, 1000);
  const aoNode = gtvbao(depthTexture, normalTexture, camera);
  let depthMode = false;
  let modeReads = 0;
  const renderer = {
    get logarithmicDepthBuffer() {
      modeReads += 1;
      return depthMode;
    },
  };

  try {
    // A separate AO texture keeps this test from triggering aoNode.setup().
    const output = aoNode.createDepthAwareAoFromBuffers(
      aoTexture, depthTexture, normalTexture, vec2(0.3, 0.4)
    );
    assert.equal(modeReads, 0);

    for (const logarithmic of [false, true, false]) {
      depthMode = logarithmic;
      const readsBeforeBuild = modeReads;
      const builder = new SetupNodeBuilder(null, renderer, null);
      builder.setShaderStage("fragment");
      builder.flowBuildStage(output, "setup");

      assert.ok(modeReads > readsBeforeBuild, "read the current renderer during shader build");
      assert.equal(Array.from(builder.nodes).includes(aoNode), false, "AO setup must not select the mode");
      assert.ok(Array.from(builder.nodes).includes(depthTexture), "use the supplied depth texture");
      const cameraProperties = Array.from(builder.nodes).flatMap((node) =>
        node instanceof ReferenceNode && node.object === camera ? [node.property] : []
      );
      // Perspective reconstruction only needs the inverse projection. Logarithmic
      // decoding additionally depends on the source camera's near/far uniforms.
      assert.deepEqual(cameraProperties.sort(), logarithmic && !orthographic ? ["far", "near"] : []);
    }
  } finally {
    aoNode.dispose();
    for (const value of textures) value.dispose();
  }
});
