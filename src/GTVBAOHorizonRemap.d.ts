import type { Node } from "three/webgpu";
import type { GTVBAOSectorMeasure } from "./GTVBAOSectorMeasure.js";

export function createHorizonRemap(
  measure: GTVBAOSectorMeasure,
  normalAngle: Node<"float">,
  cosN: Node<"float">,
  sinN: Node<"float">
): (horizonCos: Node<"vec2">, directionIsRight: boolean) => Node<"vec2">;
