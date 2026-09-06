import type GTVBAODenoiseNode from "./GTVBAODenoiseNode.js";
import type GTVBAONode from "./GTVBAONode.js";
import type { GTVBAOSectorMeasure } from "./GTVBAOSectorMeasure.js";

export interface GTVBAOPreset {
  resolutionScale: number;
  sliceCount: number;
  stepCount: number;
  radius: number;
  thickness: number;
  aoIntensity: number;
  expFactor: number;
  useScreenSpaceSampling: boolean;
  useLinearThickness: boolean;
  linearThicknessScale: number;
  maxThickness: number;
  /** Jitter the sampling per frame; expects a TRAA resolve after the lit pass. */
  temporal: boolean;
  /** Read GTVBAODenoiseNode's output instead of the raw AO. */
  denoise: boolean;
  denoiseRadius: number;
  sectorMeasure: GTVBAOSectorMeasure;
  usePerspectiveCorrectSlice: boolean;
  /** March on an AO-resolution linear-depth MIP chain instead of the scene depth. */
  useDepthMips: boolean;
}

export type GTVBAOPresetName =
  | "Low"
  | "Balanced"
  | "High"
  | "No Temporal Low"
  | "No Temporal High";

export const GTVBAO_PRESETS: Readonly<Record<GTVBAOPresetName, GTVBAOPreset>>;
export const GTVBAO_PRESET_NAMES: readonly GTVBAOPresetName[];
export const DEFAULT_GTVBAO_PRESET: "Balanced";

export function applyGtvbaoPreset(
  gtvbaoNode: GTVBAONode,
  preset: GTVBAOPresetName | GTVBAOPreset,
  denoiseNode?: GTVBAODenoiseNode | null
): GTVBAOPreset;
