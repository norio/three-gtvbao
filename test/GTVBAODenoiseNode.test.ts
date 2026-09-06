import assert from "node:assert/strict";
import { Color, PerspectiveCamera } from "three";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAODenoiseNode, {
  type GTVBAODenoiseOptions,
  type SampleableTextureNode,
} from "../src/GTVBAODenoiseNode.js";

test("GTVBAODenoiseNode keeps a fixed denoise kernel by default", () => {
  const node = createDenoiseNode();
  const renderer = createFakeRenderer();
  node.index.value = 2;

  updateDenoiseNode(node, { frameId: 7, renderer });
  assert.equal(node.index.value, 2);
  assert.equal(renderer.renderCount, 1);

  node.dispose();
});

test("GTVBAODenoiseNode rotates its denoise kernel when enabled", () => {
  const node = createDenoiseNode({ useTemporalDenoiseRotation: true });
  const renderer = createFakeRenderer();

  updateDenoiseNode(node, { frameId: 7, renderer });
  assert.equal(node.index.value, 3);
  updateDenoiseNode(node, { frameId: 8, renderer });
  assert.equal(node.index.value, 0);
  assert.equal(renderer.renderCount, 2);

  node.dispose();
});

test("GTVBAODenoiseNode stores the normal encoding option", () => {
  const node = createDenoiseNode({ normalEncoding: "directionToColor" });

  assert.equal(node.normalEncoding, "directionToColor");

  node.dispose();
});

test("GTVBAODenoiseNode rebuilds its fragment when the AO depth-mips variant changes", () => {
  const linearDepthNode = createTextureNode();
  const linearDepthSource = {
    useDepthMips: { value: true },
    getDepthMipNodes: () => [linearDepthNode],
  };
  const node = createDenoiseNode({
    linearDepthSource: linearDepthSource as never,
  });
  const material = (node as unknown as { _material: { version: number } })._material;
  const renderer = createFakeRenderer();
  const builder = {
    getSharedContext: () => ({}),
    renderer: { logarithmicDepthBuffer: false },
  };

  node.setup(builder as never);
  const builtVersion = material.version;

  updateDenoiseNode(node, { frameId: 1, renderer });
  assert.equal(material.version, builtVersion);

  linearDepthSource.useDepthMips.value = false;
  updateDenoiseNode(node, { frameId: 2, renderer });
  assert.equal(material.version, builtVersion + 1);

  updateDenoiseNode(node, { frameId: 3, renderer });
  assert.equal(material.version, builtVersion + 1);

  linearDepthSource.useDepthMips.value = true;
  updateDenoiseNode(node, { frameId: 4, renderer });
  assert.equal(material.version, builtVersion + 2);

  // Replacing one enabled source with another must update the bound depth.
  const replacementDepthNode = createTextureNode();
  node.linearDepthSource = {
    useDepthMips: { value: true },
    getDepthMipNodes: () => [replacementDepthNode],
  } as never;
  updateDenoiseNode(node, { frameId: 5, renderer });
  assert.equal(material.version, builtVersion + 3);

  updateDenoiseNode(node, { frameId: 6, renderer });
  assert.equal(material.version, builtVersion + 3);

  node.dispose();
});

function createDenoiseNode(options: GTVBAODenoiseOptions = {}) {
  return new GTVBAODenoiseNode(
    createTextureNode(),
    uniform(1) as never,
    null,
    new PerspectiveCamera(),
    options
  );
}

function createTextureNode(): SampleableTextureNode {
  return {
    value: {
      image: { width: 1, height: 1 },
      dispose() {},
    },
    sample: () => uniform(1) as never,
  } as unknown as SampleableTextureNode;
}

function updateDenoiseNode(node: GTVBAODenoiseNode, frame: unknown) {
  (node as unknown as { updateBefore(frame: unknown): void }).updateBefore(frame);
}

function createFakeRenderer() {
  let renderTarget: unknown = null;
  return {
    autoClear: true,
    outputColorSpace: "",
    renderCount: 0,
    toneMapping: 0,
    toneMappingExposure: 1,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getClearAlpha: () => 1,
    getClearColor: (target = new Color()) => target.set(0),
    getMRT: () => null,
    getPixelRatio: () => 1,
    getRenderObjectFunction: () => null,
    getRenderTarget: () => renderTarget,
    getScissorTest: () => false,
    render() {
      this.renderCount += 1;
    },
    setClearColor: () => {},
    setMRT: () => {},
    setPixelRatio: () => {},
    setRenderObjectFunction: () => {},
    setRenderTarget: (target: unknown) => {
      renderTarget = target;
    },
    setScissorTest: () => {},
  };
}
