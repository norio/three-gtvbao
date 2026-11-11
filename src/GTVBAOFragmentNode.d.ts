import type { Node } from "three/webgpu";
import type GTVBAONode from "./GTVBAONode.js";

export function isAoIntensityFastPath(value: number): boolean;
export function isExpFactorFastPath(value: number): boolean;
export function createGtvbaoFragmentNode(
  aoNode: GTVBAONode,
  logarithmicDepthBuffer: boolean,
  sharedContext: object
): Node<"vec4">;
