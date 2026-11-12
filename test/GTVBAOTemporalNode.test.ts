import assert from "node:assert/strict";
import {
  Color,
  DataTexture,
  Matrix4,
  NodeBuilder,
  OrthographicCamera,
  PerspectiveCamera,
  RedFormat,
  FloatType,
  Vector3,
  type Node,
} from "three/webgpu";
import { texture } from "three/tsl";
import { test } from "vitest";
import { GTVBAONode, GTVBAOTemporalNode, gtvbaoTemporal } from "../src/index.js";

type Internals = {
  _historyValid: { value: number };
  _reprojection: { value: Matrix4 };
  _material: { fragmentNode: Node | null };
  _resolveRenderTarget: { width: number; height: number; texture: object };
  _historyRenderTarget: { width: number; height: number; texture: object };
};
const internalsOf = (node: GTVBAOTemporalNode) => node as unknown as Internals;

// The real setup stage needs no GPU backend. @types/three still marks this
// constructor abstract and omits flowBuildStage(), so describe that API here.
const SetupNodeBuilder = NodeBuilder as unknown as {
  new (
    object: null,
    renderer: { readonly logarithmicDepthBuffer: boolean },
    parser: null
  ): NodeBuilder & { flowBuildStage(node: Node, stage: "setup"): unknown };
};

function createRig({ orthographic = false, withNormal = true, width = 8, height = 4, options = {} } = {}) {
  const dataTexture = (w: number, h: number) => new DataTexture(new Float32Array(w * h), w, h, RedFormat, FloatType);
  const textures = {
    ao: dataTexture(width, height),
    depth: dataTexture(width, height),
    normal: dataTexture(1, 1),
    velocity: dataTexture(width, height),
  };
  const camera = orthographic ? new OrthographicCamera(-4, 4, 4, -4, 0.1, 100) : new PerspectiveCamera(55, 2, 0.1, 100);
  const aoNode = new GTVBAONode(texture(textures.depth), withNormal ? texture(textures.normal) : null, camera);
  const node = gtvbaoTemporal(texture(textures.ao), texture(textures.velocity), aoNode, options);
  return {
    aoNode, camera, node, textures, internals: internalsOf(node),
    dispose() {
      node.dispose();
      aoNode.dispose();
      for (const value of Object.values(textures)) value.dispose();
    },
  };
}

test("GTVBAOTemporalNode defaults and options", () => {
  const defaults = createRig();
  assert.ok(defaults.node instanceof GTVBAOTemporalNode);
  assert.equal(defaults.node.blend.value, 0.1);
  assert.equal(defaults.node.clampSigma.value, 1.5);
  assert.equal(defaults.node.parallaxBlend.value, 20);
  assert.equal(defaults.node.textureNode.value, defaults.textures.ao);
  assert.equal(defaults.node.aoNode, defaults.aoNode);
  defaults.dispose();

  const custom = createRig({ options: { blend: 0.3, clampSigma: 2, parallaxBlend: 0 } });
  assert.equal(custom.node.blend.value, 0.3);
  assert.equal(custom.node.clampSigma.value, 2);
  // A zero option must not fall back to the default.
  assert.equal(custom.node.parallaxBlend.value, 0);
  custom.dispose();
});

for (const orthographic of [false, true]) for (const withNormal of [true, false]) {
  const label = `${orthographic ? "orthographic" : "perspective"}, ${withNormal ? "normal buffer" : "depth-derived normals"}`;

  test(`GTVBAOTemporalNode builds its fragment shader (${label})`, () => {
    const rig = createRig({ orthographic, withNormal });
    const renderer = { logarithmicDepthBuffer: false };
    try {
      assert.equal(rig.internals._material.fragmentNode, null);
      const output = rig.node.setup({ getSharedContext: () => ({}), renderer } as never);
      assert.ok(output);
      const fragmentNode = rig.internals._material.fragmentNode;
      assert.ok(fragmentNode, "setup assigns the material's fragment node");

      const builder = new SetupNodeBuilder(null, renderer, null);
      builder.setShaderStage("fragment");
      builder.flowBuildStage(fragmentNode, "setup");
      const nodes = Array.from(builder.nodes);
      assert.ok(nodes.includes(rig.aoNode.depthNode), "reads the scene depth");
      assert.equal(nodes.includes(rig.aoNode.normalNode as Node), withNormal, "reads the normal buffer only when one is supplied");
    } finally {
      rig.dispose();
    }
  });
}

test("GTVBAOTemporalNode renders into the resolve target and then copies it to the history target", () => {
  const rig = createRig({ width: 8, height: 4 });
  const { internals } = rig;
  const { events, renderer } = createRecordingRenderer(() => internals._historyValid.value);
  const name = (target: unknown) => target === internals._resolveRenderTarget ? "resolve" : target === internals._historyRenderTarget ? "history" : String(target);

  update(rig.node, 0, renderer);

  assert.deepEqual(events.map((event) => event.type === "render" ? "render" : event.type), [
    "initRenderTarget", "initRenderTarget", "setRenderTarget", "render", "copyTextureToTexture", "setRenderTarget",
  ]);
  assert.deepEqual(events.filter((event) => event.type === "initRenderTarget").map((event) => name(event.target)), ["resolve", "history"]);
  const renderIndex = events.findIndex((event) => event.type === "render");
  assert.equal(name(events[renderIndex - 1].target), "resolve", "the quad renders into the resolve target");
  assert.equal(events[renderIndex + 1].source, internals._resolveRenderTarget.texture);
  assert.equal(events[renderIndex + 1].destination, internals._historyRenderTarget.texture);
  for (const target of [internals._resolveRenderTarget, internals._historyRenderTarget]) {
    assert.deepEqual([target.width, target.height], [8, 4], "both targets take the input texture's size");
  }

  // The size follows the input texture, not the AO node or the renderer.
  rig.textures.ao.image.width = 20;
  rig.textures.ao.image.height = 12;
  update(rig.node, 1, renderer);
  for (const target of [internals._resolveRenderTarget, internals._historyRenderTarget]) {
    assert.deepEqual([target.width, target.height], [20, 12]);
  }

  rig.dispose();
});

test("GTVBAOTemporalNode keeps its history across a paused loop and drops it on resize or reset()", () => {
  const rig = createRig();
  const { events, renderer } = createRecordingRenderer(() => rig.internals._historyValid.value);
  const validAtRender: Array<[string, number]> = [];
  const step = (label: string, frameId: number) => {
    events.length = 0;
    update(rig.node, frameId, renderer);
    validAtRender.push([label, events.find((event) => event.type === "render")!.historyValid as number]);
  };

  step("first frame", 0);
  step("next frame", 1);
  // An application may stop and resume its loop, so frame ids are not consecutive.
  step("resumed after a pause", 500);
  step("frame id going backwards", 3);
  rig.textures.ao.image.width = 16;
  step("after a resize", 4);
  step("after the resize frame", 5);
  rig.node.reset();
  step("after reset()", 6);
  step("after the reset frame", 7);

  assert.deepEqual(validAtRender, [
    ["first frame", 0],
    ["next frame", 1],
    ["resumed after a pause", 1],
    ["frame id going backwards", 1],
    ["after a resize", 0],
    ["after the resize frame", 1],
    ["after reset()", 0],
    ["after the reset frame", 1],
  ]);

  // Rebuilding the shader for a different consumer context also starts fresh.
  rig.node.setup({ getSharedContext: () => ({ changed: 1 }), renderer: { logarithmicDepthBuffer: false } } as never);
  step("after a rebuild with a new context", 8);
  assert.equal(validAtRender.at(-1)![1], 0);

  rig.dispose();
});

test("GTVBAOTemporalNode reprojects the previous view space into the current one", () => {
  const rig = createRig();
  const { events, renderer } = createRecordingRenderer(() => 0);
  const poseA = (camera: PerspectiveCamera) => { camera.position.set(1, 2, 3); camera.rotation.set(0.1, 0.4, 0); };
  const poseB = (camera: PerspectiveCamera) => { camera.position.set(-2, 0.5, 4); camera.rotation.set(-0.2, 0.9, 0.1); };
  const camera = rig.camera as PerspectiveCamera;

  poseA(camera);
  camera.updateMatrixWorld(true);
  const worldA = camera.matrixWorld.clone();
  update(rig.node, 0, renderer);
  poseB(camera);
  camera.updateMatrixWorld(true);
  update(rig.node, 1, renderer);

  // Whatever the matrix layout, it must carry a view-A position to view B.
  for (const world of [new Vector3(0, 0, 0), new Vector3(3, -1, 2), new Vector3(-4, 2, -6)]) {
    const inA = world.clone().applyMatrix4(worldA.clone().invert());
    const inB = world.clone().applyMatrix4(camera.matrixWorldInverse);
    const carried = inA.clone().applyMatrix4(rig.internals._reprojection.value);
    assert.ok(carried.distanceTo(inB) < 1e-4, `${carried.toArray()} != ${inB.toArray()}`);
  }
  assert.equal(events.filter((event) => event.type === "render").length, 2);
  rig.dispose();
});

function update(node: GTVBAOTemporalNode, frameId: number, renderer: unknown) {
  (node as unknown as { updateBefore(frame: unknown): void }).updateBefore({ frameId, renderer });
}

type RendererEvent = { type: string; target?: unknown; source?: unknown; destination?: unknown; historyValid?: number };

function createRecordingRenderer(historyValid: () => number) {
  const events: RendererEvent[] = [];
  let renderTarget: unknown = null;
  const renderer = {
    autoClear: true,
    outputColorSpace: "",
    toneMapping: 0,
    toneMappingExposure: 1,
    copyTextureToTexture: (source: unknown, destination: unknown) => events.push({ type: "copyTextureToTexture", source, destination }),
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getClearAlpha: () => 1,
    getClearColor: (target = new Color()) => target.set(0),
    getMRT: () => null,
    getPixelRatio: () => 1,
    getRenderObjectFunction: () => null,
    getRenderTarget: () => renderTarget,
    getScissorTest: () => false,
    initRenderTarget: (target: unknown) => events.push({ type: "initRenderTarget", target }),
    render: () => events.push({ type: "render", historyValid: historyValid() }),
    setClearColor: () => {},
    setMRT: () => {},
    setPixelRatio: () => {},
    setRenderObjectFunction: () => {},
    setRenderTarget: (target: unknown) => {
      renderTarget = target;
      events.push({ type: "setRenderTarget", target });
    },
    setScissorTest: () => {},
  };
  return { events, renderer };
}
