import * as THREE from "three/webgpu";
import { GUI } from "three/examples/jsm/libs/lil-gui.module.min.js";
import {
  GTVBAO_DEBUG_MODE_OPTIONS,
  GTVBAO_PRESET_NAMES,
  GTVBAO_SECTOR_MEASURE_OPTIONS,
  GTVBAO_VARIANT_LIMITS,
  type GTVBAODenoiseNode,
  type GTVBAONode,
} from "../src/index.js";
import type { ExamplePresetName, ViewSettings } from "./main.js";

interface GuiContext {
  renderer: THREE.WebGPURenderer;
  sun: THREE.DirectionalLight;
  aoNode: GTVBAONode;
  denoiseNode: GTVBAODenoiseNode;
  settings: ViewSettings;
  applyPreset(name: ExamplePresetName): void;
  syncOutput(): void;
  resetTraaHistory(): void;
  syncStats(): void;
}

export function createGui({
  renderer,
  sun,
  aoNode,
  denoiseNode,
  settings,
  applyPreset,
  syncOutput,
  resetTraaHistory,
  syncStats,
}: GuiContext) {
  const gui = new GUI({ title: "Quality & lighting" });
  gui.add(settings, "showFps").name("Show FPS").onChange(syncStats);
  const presetController = gui
    .add(settings, "preset", ["Showcase", ...GTVBAO_PRESET_NAMES, "Custom"])
    .name("Preset")
    .onChange((name: ExamplePresetName | "Custom") => {
      if (name === "Custom") return;
      applyPreset(name);
      gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
    });
  // Any manual edit leaves the preset.
  const custom = () => {
    settings.preset = "Custom";
    presetController.updateDisplay();
    resetTraaHistory();
    syncOutput();
  };

  const pipeline = gui.addFolder("Pipeline");
  const onPipelineChange = () => {
    custom();
    syncOutput();
  };
  pipeline.add(settings, "aoEnabled").name("AO").onChange(onPipelineChange);
  pipeline.add(settings, "aoOnly").name("Show AO only").onChange(syncOutput);
  pipeline.add(settings, "denoise").name("Denoise").onChange(onPipelineChange);
  pipeline.add(settings, "temporal").name("Temporal jitter").onChange(onPipelineChange);
  pipeline.add(settings, "traa").name("TRAA").onChange(onPipelineChange);
  pipeline
    .add(denoiseNode.radius, "value", 1, 5, 1)
    .name("Denoise radius")
    .onChange(custom);

  // Bind directly to the node; variant getters return the clamped values.
  const ao = gui.addFolder("GTVBAO");
  ao.close();
  const { sliceCount, stepCount } = GTVBAO_VARIANT_LIMITS;
  ao.add(aoNode, "resolutionScale", [0.25, 0.5, 0.75, 1]).name("Resolution scale").onChange(custom);
  ao.add(aoNode.sliceCount, "value", sliceCount.min, sliceCount.max, 1).name("Slices").onChange(custom);
  ao.add(aoNode.stepCount, "value", stepCount.min, stepCount.max, 1).name("Steps").onChange(custom);
  ao.add(aoNode.radius, "value", 0.5, 8, 0.1).name("Radius").onChange(custom);
  ao.add(aoNode.useScreenSpaceSampling, "value").name("Screen-space radius").onChange(custom);
  ao.add(aoNode.thickness, "value", 0.01, 1, 0.01).name("Thickness").onChange(custom);
  ao.add(aoNode.useLinearThickness, "value").name("Linear thickness").onChange(custom);
  ao.add(aoNode.linearThicknessScale, "value", 1, 200, 1).name("Linear thickness scale").onChange(custom);
  ao.add(aoNode.maxThickness, "value", 0.01, 4, 0.01).name("Max thickness").onChange(custom);
  ao.add(aoNode.aoIntensity, "value", 0.5, 4, 0.05).name("Intensity").onChange(custom);
  ao.add(aoNode.expFactor, "value", 1, 4, 0.1).name("Step exponent").onChange(custom);
  ao.add(aoNode.sectorMeasure, "value", GTVBAO_SECTOR_MEASURE_OPTIONS).name("Sector measure").onChange(custom);
  ao.add(aoNode.usePerspectiveCorrectSlice, "value").name("Perspective-correct slices").onChange(custom);
  ao.add(aoNode.useDepthMips, "value").name("Depth MIPs").onChange(custom);
  ao.add(aoNode, "useDepthAwareUpsample").name("Depth-aware upsample").onChange(resetTraaHistory);
  ao.add(aoNode.debugMode, "value", GTVBAO_DEBUG_MODE_OPTIONS).name("Debug view").onChange(syncOutput);

  const shadow = gui.addFolder("Shadow");
  shadow.close();
  const shadowTypes = {
    Basic: THREE.BasicShadowMap,
    PCF: THREE.PCFShadowMap,
    "PCF Soft": THREE.PCFSoftShadowMap,
    VSM: THREE.VSMShadowMap,
  };
  shadow
    .add(renderer.shadowMap, "type", shadowTypes)
    .name("Type")
    .onChange(() => {
      // The shadow node caches its filter; rebuilding the map applies the new type.
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
      sun.shadow.needsUpdate = true;
      resetTraaHistory();
    });
  shadow.add(sun.shadow, "radius", 0, 16, 0.5).name("Radius (PCF / VSM)").onChange(resetTraaHistory);
  shadow.add(sun.shadow, "blurSamples", 2, 32, 1).name("Blur samples (VSM)").onChange(resetTraaHistory);
  shadow.add(sun.shadow, "bias", -0.005, 0.005, 0.0001).name("Bias").onChange(resetTraaHistory);
  shadow.add(sun.shadow, "normalBias", 0, 0.2, 0.005).name("Normal bias").onChange(resetTraaHistory);
  shadow.add(sun.shadow, "intensity", 0, 1, 0.05).name("Shadow intensity").onChange(resetTraaHistory);
  shadow.add(sun, "intensity", 0, 5, 0.1).name("Sun intensity").onChange(resetTraaHistory);

  // Every value the panel edits, as JSON, for turning a tuned state into defaults.
  const snapshot = () => ({
    settings: { ...settings },
    ao: {
      resolutionScale: aoNode.resolutionScale,
      sliceCount: aoNode.sliceCount.value,
      stepCount: aoNode.stepCount.value,
      radius: aoNode.radius.value,
      useScreenSpaceSampling: aoNode.useScreenSpaceSampling.value,
      thickness: aoNode.thickness.value,
      useLinearThickness: aoNode.useLinearThickness.value,
      linearThicknessScale: aoNode.linearThicknessScale.value,
      maxThickness: aoNode.maxThickness.value,
      aoIntensity: aoNode.aoIntensity.value,
      expFactor: aoNode.expFactor.value,
      sectorMeasure: aoNode.sectorMeasure.value,
      usePerspectiveCorrectSlice: aoNode.usePerspectiveCorrectSlice.value,
      useDepthMips: aoNode.useDepthMips.value,
      useDepthAwareUpsample: aoNode.useDepthAwareUpsample,
      debugMode: aoNode.debugMode.value,
    },
    denoise: { radius: denoiseNode.radius.value },
    shadow: {
      type: Object.entries(shadowTypes).find(([, value]) => value === renderer.shadowMap.type)?.[0],
      radius: sun.shadow.radius,
      blurSamples: sun.shadow.blurSamples,
      bias: sun.shadow.bias,
      normalBias: sun.shadow.normalBias,
      intensity: sun.shadow.intensity,
      sunIntensity: sun.intensity,
    },
  });
  gui
    .add(
      {
        copy: () => {
          const json = JSON.stringify(snapshot(), null, 2);
          console.log(json);
          navigator.clipboard?.writeText(json).catch(() => {});
        },
      },
      "copy"
    )
    .name("Copy settings (JSON)");

  return gui;
}
