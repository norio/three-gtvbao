import assert from "node:assert/strict";
import { PerspectiveCamera, RedFormat, RGBAFormat } from "three";
import { NodeBuilder } from "three/webgpu";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";

// The installed NodeBuilder is concrete; the older declarations mark it abstract.
const TypeNodeBuilder = NodeBuilder as unknown as { new (object: null, renderer: null): NodeBuilder };

test("initial debug output has its RGBA texture before a consumer builds", () => {
  const ao = new GTVBAONode(uniform(1), null, new PerspectiveCamera(), { debugMode: 5 });
  try {
    assert.equal(ao.getTextureNode().value.format, RGBAFormat);
    assert.equal(ao.getTextureNode().getNodeType(new TypeNodeBuilder(null, null)), "vec4");
  } finally {
    ao.dispose();
  }
});

test("variant callbacks can build the selected output before its first render", () => {
  const ao = new GTVBAONode(uniform(1), null, new PerspectiveCamera());
  const output = ao.getTextureNode();
  const formats: number[] = [];
  ao.setVariantChangeCallback(() => {
    assert.equal(ao.getTextureNode(), output, "keep the consumer's texture node");
    const debug = ao.debugMode.value > 0;
    assert.equal(output.value.format, debug ? RGBAFormat : RedFormat);
    if (debug) assert.equal(output.getNodeType(new TypeNodeBuilder(null, null)), "vec4");
    formats.push(output.value.format);
  });
  try {
    ao.debugMode.value = 1;
    ao.debugMode.value = 5;
    ao.debugMode.value = 0;
    ao.batchVariantChanges(() => { ao.debugMode.value = 2; ao.debugMode.value = 5; });
    assert.deepEqual(formats, [RGBAFormat, RGBAFormat, RedFormat, RGBAFormat]);
  } finally {
    ao.dispose();
  }
});
