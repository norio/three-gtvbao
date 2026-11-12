import type { Vector2 } from "three";
import type { Node } from "three/webgpu";
import type GTVBAONode from "./GTVBAONode.js";
import type { GTVBAOFragmentNodes } from "./GTVBAONode.js";

export function setGtvbaoUpsampleJitterPhase(target: Vector2, frameId: number): Vector2;

export function createGtvbaoDepthAwareAo(
  aoNode: GTVBAONode,
  aoTexture: Node,
  fragment: GTVBAOFragmentNodes
): Node<"float">;

export function createGtvbaoDepthAwareAoFromBuffers(
  aoNode: GTVBAONode,
  aoTexture: Node,
  depthTexture: Node,
  normalTexture: Node,
  screenUv: Node
): Node<"float">;
