import assert from "node:assert/strict";
import { Vector4 } from "three/webgpu";
import { uniform } from "three/tsl";
import { test } from "vitest";
import { buildMathProbe, createSliceProbe } from "./webgpu/math-nodes.js";

// The numerical checks execute these same production helpers in math.html,
// against quaternion rotation and a finite difference of camera projection.
test("the production slice frame and projection build as WGSL", () => {
  const input = uniform(new Vector4(0.3, -0.2, 0.9, 0.7));
  const row = uniform(0);
  const output = createSliceProbe(input, row);
  const { builder, flow } = buildMathProbe(output);

  assert.equal(output.getNodeType(builder), "vec4");
  assert.ok(Array.from(builder.nodes).includes(input));
  assert.ok(Array.from(builder.nodes).includes(row), "compile all three probe outputs");
  assert.ok(flow.result.length > 0);
});
