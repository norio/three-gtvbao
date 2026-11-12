import type { Node, TextureNode, UniformNode } from "three/webgpu";
import type GTVBAONode from "./GTVBAONode.js";

export interface GTVBAOTemporalOptions {
  blend?: number;
  clampSigma?: number;
  parallaxBlend?: number;
}

export default class GTVBAOTemporalNode extends Node<"float"> {
  textureNode: TextureNode;
  velocityNode: TextureNode;
  aoNode: GTVBAONode;
  blend: UniformNode<"float", number>;
  clampSigma: UniformNode<"float", number>;
  parallaxBlend: UniformNode<"float", number>;

  constructor(
    textureNode: TextureNode,
    velocityNode: TextureNode,
    aoNode: GTVBAONode,
    options?: GTVBAOTemporalOptions
  );
  getTextureNode(): TextureNode;
  reset(): void;
  dispose(): void;
}

export function gtvbaoTemporal(
  aoTextureNode: Node,
  velocityNode: TextureNode,
  aoNode: GTVBAONode,
  options?: GTVBAOTemporalOptions
): GTVBAOTemporalNode;
