import type { Node } from "three/webgpu";

export function getPerspectiveViewPosition(
  screenPosition: Node<"vec2">,
  depth: Node<"float">,
  projectionMatrixInverse: Node<"mat4">
): Node<"vec3">;

export function createPerspectiveTexelViewPosition(
  projectionMatrixInverse: Node<"mat4">,
  texelSize: Node<"vec2">
): (sampleTexel: Node<"vec2">, sampleDepth: Node<"float">) => Node<"vec3">;

export function createPerspectiveViewPositionFromLinearDepth(
  projectionMatrixInverse: Node<"mat4">
): (screenPosition: Node<"vec2">, linearDepth: Node<"float">) => Node<"vec3">;

export function getViewPosition(
  screenPosition: Node<"vec2">,
  depth: Node<"float">,
  projectionMatrixInverse: Node<"mat4">,
  isOrthographicCamera: boolean
): Node<"vec3">;

export function createTexelViewPosition(
  projectionMatrixInverse: Node<"mat4">,
  texelSize: Node<"vec2">,
  isOrthographicCamera: boolean
): (sampleTexel: Node<"vec2">, sampleDepth: Node<"float">) => Node<"vec3">;

export function createViewPositionFromLinearDepth(
  projectionMatrixInverse: Node<"mat4">,
  isOrthographicCamera: boolean
): (screenPosition: Node<"vec2">, linearDepth: Node<"float">) => Node<"vec3">;
