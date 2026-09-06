import type { Node } from "three/webgpu";

export interface GTVBAOViewVectorFrame {
  tangent: Node<"vec3">;
  bitangent: Node<"vec3">;
}

export function createViewVectorFrame(viewDir: Node<"vec3">): GTVBAOViewVectorFrame;

export function projectSliceDirection(
  frame: GTVBAOViewVectorFrame,
  viewDir: Node<"vec3">,
  direction: Node<"vec2">
): Node<"vec3">;
