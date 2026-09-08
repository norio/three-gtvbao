import type { OrthographicCamera, PerspectiveCamera } from "three";
import type { Node, TempNode, TextureNode, UniformNode } from "three/webgpu";
import type GTVBAONode from "./GTVBAONode.js";
import type { GTVBAONormalEncoding } from "./GTVBAONode.js";

export type SampleableTextureNode = TextureNode;

export type GTVBAODenoiseNormalEncoding = GTVBAONormalEncoding;

export interface GTVBAODenoiseOptions {
  normalEncoding?: GTVBAODenoiseNormalEncoding;
  useTemporalDenoiseRotation?: boolean;
  linearDepthSource?: GTVBAONode | null;
}

export default class GTVBAODenoiseNode extends TempNode<"float"> {
  textureNode: SampleableTextureNode;
  depthNode: SampleableTextureNode;
  normalNode: SampleableTextureNode | null;
  noiseNode: SampleableTextureNode | null;
  readonly normalEncoding: GTVBAODenoiseNormalEncoding;
  useTemporalDenoiseRotation: boolean;
  linearDepthSource: GTVBAONode | null;
  lumaPhi: UniformNode<"float", number>;
  depthPhi: UniformNode<"float", number>;
  normalPhi: UniformNode<"float", number>;
  radius: UniformNode<"float", number>;
  index: UniformNode<"float", number>;

  getTextureNode(): SampleableTextureNode;

  constructor(
    textureNode: SampleableTextureNode,
    depthNode: SampleableTextureNode,
    normalNode: SampleableTextureNode | null,
    camera: PerspectiveCamera | OrthographicCamera,
    options?: GTVBAODenoiseOptions
  );
  dispose(): void;
}

export function gtvbaoDenoise(
  node: Node,
  depthNode: Node,
  normalNode: Node | null,
  camera: PerspectiveCamera | OrthographicCamera,
  options?: GTVBAODenoiseOptions
): GTVBAODenoiseNode;
