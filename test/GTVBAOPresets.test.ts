import assert from "node:assert/strict";
import { PerspectiveCamera } from "three";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";
import type GTVBAODenoiseNode from "../src/GTVBAODenoiseNode.js";
import {
  DEFAULT_GTVBAO_PRESET,
  GTVBAO_PRESETS,
  GTVBAO_PRESET_NAMES,
  applyGtvbaoPreset,
} from "../src/GTVBAOPresets.js";

test("GTVBAO balanced preset matches the design default", () => {
  const preset = GTVBAO_PRESETS[DEFAULT_GTVBAO_PRESET];

  assert.equal(DEFAULT_GTVBAO_PRESET, "Balanced");
  assert.equal(preset.resolutionScale, 0.5);
  assert.equal(preset.sliceCount, 2);
  assert.equal(preset.stepCount, 6);
  assert.equal(preset.radius, 3);
  assert.equal(preset.thickness, 0.12);
  assert.equal(preset.aoIntensity, 1);
  assert.equal(preset.expFactor, 2);
  assert.equal(preset.useScreenSpaceSampling, true);
  assert.equal(preset.useLinearThickness, true);
  assert.equal(preset.linearThicknessScale, 100);
  assert.equal(preset.maxThickness, 1);
  assert.equal(preset.temporal, true);
  assert.equal(preset.denoise, false);
  assert.equal(preset.sectorMeasure, "cosine");
  assert.equal(preset.usePerspectiveCorrectSlice, true);
  assert.equal(preset.useDepthMips, true);
});

test("GTVBAO high presets use a thin clamped thickness with the cosine sector measure", () => {
  for (const name of ["High", "No Temporal High"] as const) {
    const preset = GTVBAO_PRESETS[name];

    assert.equal(preset.thickness, 0.08);
    assert.equal(preset.maxThickness, 0.35);
    assert.equal(preset.sectorMeasure, "cosine");
  }
});

test("GTVBAO no-temporal presets use denoise by default", () => {
  for (const name of ["No Temporal Low", "No Temporal High"] as const) {
    const preset = GTVBAO_PRESETS[name];

    assert.equal(preset.temporal, false);
    assert.equal(preset.denoise, true);
  }
});

test("GTVBAO_PRESET_NAMES lists every preset", () => {
  assert.deepEqual(GTVBAO_PRESET_NAMES, Object.keys(GTVBAO_PRESETS));
});

test("applyGtvbaoPreset applies a preset with one variant rebuild", () => {
  const node = new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera());
  let invalidations = 0;
  node.setVariantChangeCallback(() => {
    invalidations += 1;
  });
  const denoiseNode = {
    radius: { value: 0 },
    useTemporalDenoiseRotation: false,
  } as unknown as GTVBAODenoiseNode;

  const preset = applyGtvbaoPreset(node, "High", denoiseNode);

  assert.equal(preset, GTVBAO_PRESETS.High);
  assert.equal(invalidations, 1);
  assert.equal(node.resolutionScale, 1);
  assert.equal(node.sliceCount.value, 3);
  assert.equal(node.stepCount.value, 12);
  assert.equal(node.thickness.value, 0.08);
  assert.equal(node.maxThickness.value, 0.35);
  assert.equal(node.useTemporalFiltering, true);
  assert.equal(denoiseNode.radius.value, 2);
  assert.equal(denoiseNode.useTemporalDenoiseRotation, false);

  applyGtvbaoPreset(node, "No Temporal Low", denoiseNode);

  assert.equal(invalidations, 2);
  assert.equal(node.resolutionScale, 0.5);
  assert.equal(node.stepCount.value, 6);
  assert.equal(node.useTemporalFiltering, false);
  assert.equal(denoiseNode.useTemporalDenoiseRotation, false);

  // A custom preset object works the same way; the denoiser is optional.
  applyGtvbaoPreset(node, { ...GTVBAO_PRESETS.Balanced, sliceCount: 4 });

  assert.equal(invalidations, 3);
  assert.equal(node.sliceCount.value, 4);
  assert.equal(node.useTemporalFiltering, true);

  assert.throws(() => applyGtvbaoPreset(node, "Ultra" as never), /Unknown GTVBAO preset/);

  node.dispose();
});
