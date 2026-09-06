import assert from "node:assert/strict";
import { Vector4 } from "three/webgpu";
import { uniform } from "three/tsl";
import { test } from "vitest";
import { GTVBAO_SECTOR_MEASURE_OPTIONS } from "../src/GTVBAOSectorMeasure.js";
import { buildMathProbe, createCdfProbe } from "./webgpu/math-nodes.js";

// These are production TSL -> WGSL construction checks, not numerical GPU
// tests. math.html compares the executed shader against numerical integration.
test.each(Object.values(GTVBAO_SECTOR_MEASURE_OPTIONS))(
  "the production %s horizon remap builds both directions and vec2 edges as WGSL",
  (measure) => {
    const input = uniform(new Vector4(0.35, -0.6, 0.8, 0));
    const output = createCdfProbe(measure, input);
    const { builder, flow } = buildMathProbe(output);

    assert.equal(output.getNodeType(builder), "vec4");
    assert.ok(builder.nodes.includes(input), "compile the runtime input, not a JS result");
    assert.ok(flow.result.length > 0);
  }
);
