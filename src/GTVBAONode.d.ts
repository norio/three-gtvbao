import type { PerspectiveCamera } from "three";
import type { Node, TempNode, TextureNode, UniformNode } from "three/webgpu";
import type { GTVBAOSectorMeasure } from "./GTVBAOSectorMeasure.js";

export { GTVBAO_SECTOR_MEASURE_OPTIONS } from "./GTVBAOSectorMeasure.js";
export type { GTVBAOSectorMeasure } from "./GTVBAOSectorMeasure.js";

export type GTVBAONormalEncoding = "view" | "directionToColor";

export interface GTVBAOOptions {
  resolutionScale?: number;
  normalEncoding?: GTVBAONormalEncoding;
  sliceCount?: number;
  stepCount?: number;
  radius?: number;
  thickness?: number;
  aoIntensity?: number;
  expFactor?: number;
  useScreenSpaceSampling?: boolean;
  useLinearThickness?: boolean;
  linearThicknessScale?: number;
  useTemporalFiltering?: boolean;
  maxThickness?: number;
  sectorMeasure?: GTVBAOSectorMeasure;
  usePerspectiveCorrectSlice?: boolean;
  useDepthMips?: boolean;
  useDepthAwareUpsample?: boolean;
  debugMode?: number;
}

export interface GTVBAOFragmentNodes {
  screenUv: Node;
  viewPosition: Node;
  viewNormal: Node;
}

export interface GTVBAOVariantValue<T> {
  value: T;
}

export const GTVBAO_DEBUG_MODE_OPTIONS: {
  readonly Off: 0;
  readonly "Raw AO": 1;
  readonly Thickness: 2;
  readonly "Bit Count": 3;
  readonly "Normal Stability": 4;
  readonly "Temporal Jitter": 5;
};

export const GTVBAO_VARIANT_LIMITS: Record<
  "sliceCount" | "stepCount" | "debugMode",
  { min: number; max: number; step: number }
>;

export function getGtvbaoDebugVariantKey(debugMode: number): number;
export function isGtvbaoDebugEnabled(debugMode: number): boolean;
export function isGtvbaoTemporalJitterDebug(debugMode: number): boolean;

export default class GTVBAONode extends TempNode<"vec4"> {
  sliceCount: GTVBAOVariantValue<number>;
  stepCount: GTVBAOVariantValue<number>;
  radius: UniformNode<"float", number>;
  thickness: UniformNode<"float", number>;
  aoIntensity: GTVBAOVariantValue<number>;
  expFactor: GTVBAOVariantValue<number>;
  useScreenSpaceSampling: GTVBAOVariantValue<boolean>;
  useLinearThickness: GTVBAOVariantValue<boolean>;
  linearThicknessScale: UniformNode<"float", number>;
  maxThickness: UniformNode<"float", number>;
  sectorMeasure: GTVBAOVariantValue<GTVBAOSectorMeasure>;
  usePerspectiveCorrectSlice: GTVBAOVariantValue<boolean>;
  useDepthMips: GTVBAOVariantValue<boolean>;
  debugMode: GTVBAOVariantValue<number>;
  useTemporalFiltering: boolean;
  resolutionScale: number;
  useDepthAwareUpsample: boolean;
  normalEncoding: GTVBAONormalEncoding;

  constructor(
    depthNode: Node,
    normalNode: Node | null,
    camera: PerspectiveCamera,
    options?: GTVBAOOptions
  );
  setVariantChangeCallback(callback: () => void): void;
  batchVariantChanges<T>(callback: () => T): T;
  getTextureNode(): TextureNode;
  getDepthMipNodes(): TextureNode[];
  createDepthAwareAo(aoTexture: Node, fragment: GTVBAOFragmentNodes): Node<"float">;
  createDepthAwareAoFromBuffers(
    aoTexture: Node,
    depthTexture: Node,
    normalTexture: Node,
    screenUv: Node
  ): Node<"float">;
  isDepthAwareUpsampleActive(): boolean;
  setSize(width: number, height: number): void;
  dispose(): void;
}

export function gtvbao(
  depthNode: Node,
  normalNode: Node | null,
  camera: PerspectiveCamera,
  options?: GTVBAOOptions
): GTVBAONode;
