import assert from "node:assert/strict";
import { PerspectiveCamera, REVISION } from "three";
import { uniform } from "three/tsl";
import * as webgpu from "three/webgpu";
import { Node } from "three/webgpu";
import { afterEach, beforeEach, test, vi } from "vitest";
import GTVBAODenoiseNode from "../src/GTVBAODenoiseNode.js";
import GTVBAONode from "../src/GTVBAONode.js";
import { GTVBAONodeBase } from "../src/GTVBAONodeBase.js";

const warnSpy = vi.spyOn(console, "warn");

beforeEach(() => {
  warnSpy.mockClear();
  warnSpy.mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

function createGtvbaoNode() {
  return new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera());
}

function createDenoiseNode() {
  return new GTVBAODenoiseNode(
    {
      value: { image: { width: 1, height: 1 }, dispose() {} },
      sample: () => uniform(1) as never,
    } as never,
    uniform(1) as never,
    null,
    new PerspectiveCamera()
  );
}

function deprecationWarnings() {
  return warnSpy.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((message) => /deprecated/i.test(message));
}

test("constructing the library nodes emits no three deprecation warning", () => {
  // three's warn() goes to console.warn unless a custom console function is set.
  assert.equal(webgpu.getConsoleFunction?.() ?? null, null);

  const ao = createGtvbaoNode();
  const denoise = createDenoiseNode();
  ao.dispose();
  denoise.dispose();

  assert.deepEqual(deprecationWarnings(), []);
});

test("GTVBAONodeBase follows the installed three revision", () => {
  if (Number.parseInt(REVISION, 10) >= 187) {
    assert.equal(GTVBAONodeBase, Node);
  } else {
    // Older three: TempNode is not deprecated, so it is the expected base.
    assert.equal(GTVBAONodeBase, (webgpu as Record<string, unknown>).TempNode);
  }
});

test("library nodes are still three Nodes", () => {
  const ao = createGtvbaoNode();
  const denoise = createDenoiseNode();

  assert.ok(ao instanceof Node);
  assert.ok(denoise instanceof Node);
  assert.ok(ao instanceof GTVBAONodeBase);
  assert.ok(denoise instanceof GTVBAONodeBase);

  ao.dispose();
  denoise.dispose();
});
