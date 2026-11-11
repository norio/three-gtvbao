import type { Node } from "three/webgpu";

export function getDepthNormal(
  screenUv: Node<"vec2">,
  depthNode: Node,
  projectionMatrixInverse: Node<"mat4">,
  isOrthographicCamera: boolean,
  convertDepth: (depth: Node<"float">) => Node<"float">
): Node<"vec3">;
