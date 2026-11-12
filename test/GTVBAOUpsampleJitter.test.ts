import assert from "node:assert/strict";
import { Color, PerspectiveCamera, Vector2 } from "three";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";
import { setGtvbaoUpsampleJitterPhase } from "../src/GTVBAOUpsample.js";

const phaseAt = (frameId: number) => setGtvbaoUpsampleJitterPhase(new Vector2(), frameId);

test("upsample jitter phase repeats every 12 frames and visits 12 distinct positions, three per quadrant", () => {
  const cycle = Array.from({ length: 12 }, (_, frameId) => phaseAt(frameId));

  // AO's own noise repeats every 4 (step offset) and 6 (slice rotation) frames; a
  // cycle of exactly 12 is the shortest one that is locked to both.
  for (const frameId of [12, 13, 25, 47, 1200 + 7]) {
    assert.deepEqual(phaseAt(frameId).toArray(), cycle[frameId % 12].toArray());
  }
  for (const phase of cycle) {
    assert.ok(phase.x >= 0 && phase.x < 1 && phase.y >= 0 && phase.y < 1, `${phase.toArray()} leaves [0,1)^2`);
  }
  assert.equal(new Set(cycle.map((phase) => phase.toArray().join())).size, 12);
  const quadrants = new Map<string, number>();
  for (const phase of cycle) {
    const key = `${Math.floor(phase.x * 2)},${Math.floor(phase.y * 2)}`;
    quadrants.set(key, (quadrants.get(key) ?? 0) + 1);
  }
  assert.deepEqual([...quadrants.values()].sort(), [3, 3, 3, 3]);
  assert.equal(quadrants.size, 4);
});

test("setGtvbaoUpsampleJitterPhase writes into and returns its target", () => {
  const target = new Vector2(9, 9);
  assert.equal(setGtvbaoUpsampleJitterPhase(target, 5), target);
  assert.deepEqual(target.toArray(), phaseAt(5).toArray());
});

test("GTVBAONode applies the upsample jitter only with temporal filtering and an active depth-aware upsample", () => {
  const cases = [
    { label: "default option is off", options: {}, scale: 0.5, expected: 0 },
    { label: "active", options: { upsampleJitter: 2 }, scale: 0.5, expected: 2 },
    { label: "temporal filtering off", options: { upsampleJitter: 2, useTemporalFiltering: false }, scale: 0.5, expected: 0 },
    { label: "full resolution", options: { upsampleJitter: 2 }, scale: 1, expected: 0 },
    { label: "depth-aware upsample off", options: { upsampleJitter: 2, useDepthAwareUpsample: false }, scale: 0.5, expected: 0 },
    { label: "depth MIPs off", options: { upsampleJitter: 2, useDepthMips: false }, scale: 0.5, expected: 0 },
  ];
  for (const { label, options, scale, expected } of cases) {
    const node = new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera(), { resolutionScale: scale, ...options });
    const internals = node as unknown as { _upsampleJitter: { value: number }; _upsampleJitterPhase: { value: Vector2 } };
    const renderer = createFakeRenderer();

    for (const frameId of [3, 4]) {
      // A pending jitter value from an earlier frame must not survive a gate change.
      internals._upsampleJitter.value = 99;
      (node as unknown as { updateBefore(frame: unknown): void }).updateBefore({ frameId, renderer });
      assert.equal(internals._upsampleJitter.value, expected, label);
      assert.deepEqual(internals._upsampleJitterPhase.value.toArray(), phaseAt(frameId).toArray(), `${label}: phase of frame ${frameId}`);
    }
    node.dispose();
  }
});

function createFakeRenderer() {
  let renderTarget: unknown = null;
  return {
    autoClear: true,
    outputColorSpace: "",
    toneMapping: 0,
    toneMappingExposure: 1,
    compute: () => {},
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getClearAlpha: () => 1,
    getClearColor: (target = new Color()) => target.set(0),
    getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
    getMRT: () => null,
    getPixelRatio: () => 1,
    getRenderObjectFunction: () => null,
    getRenderTarget: () => renderTarget,
    getScissorTest: () => false,
    render: () => {},
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
