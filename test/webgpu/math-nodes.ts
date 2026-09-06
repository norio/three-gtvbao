import { WebGPUBackend, type Node, type NodeBuilder } from "three/webgpu";
import { Fn, cos, sin, vec2, vec4 } from "three/tsl";
import { createHorizonRemap } from "../../src/GTVBAOHorizonRemap.js";
import { createViewVectorFrame, projectSliceDirection } from "../../src/GTVBAOSliceDirection.js";
import type { GTVBAOSectorMeasure } from "../../src/GTVBAOSectorMeasure.js";

export function createCdfProbe(measure: GTVBAOSectorMeasure, fixture: Node<"vec4">) {
  return Fn(() => {
    const input = fixture.toConst();
    const remap = createHorizonRemap(measure, input.x, cos(input.x), sin(input.x));
    // Each pixel carries two different horizon edges in both march directions.
    return vec4(remap(input.yz, true), remap(input.yz, false));
  })();
}

export function createSliceProbe(fixture: Node<"vec4">, row: Node<"float">) {
  return Fn(() => {
    const input = fixture.toConst();
    const viewDir = input.xyz.normalize().toConst();
    const frame = createViewVectorFrame(viewDir);
    const direction = projectSliceDirection(frame, viewDir, vec2(cos(input.w), sin(input.w)));
    return vec4(row.lessThan(1).select(frame.tangent, row.lessThan(2).select(frame.bitangent, direction)), 1);
  })();
}

// npm test generates WGSL through the installed WebGPU backend, but does not
// execute it. Numerical checks live in math.html and require a real GPU.
export function buildMathProbe(node: Node) {
  const backend = new WebGPUBackend();
  // @types/three omits these internal builder APIs. No device or renderer
  // behavior is mocked: arithmetic code generation only needs the backend.
  const builder = (backend as unknown as {
    createNodeBuilder(object: null, renderer: { backend: WebGPUBackend }): NodeBuilder & {
      flowStagesNode(node: Node, output: string): { code: string; result: string };
    };
  }).createNodeBuilder(null, { backend });
  builder.setShaderStage("fragment");
  return { builder, flow: builder.flowStagesNode(node, "vec4") };
}
