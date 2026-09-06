import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = resolve(root, "src");
const entryId = "\0tree-shaking-entry";

async function bundle(code: string, sourceAudit = false) {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [{
      name: "tree-shaking-entry",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === entryId) return id;
        // Audit statements without letting package sideEffects:false hide them.
        if (sourceAudit) {
          const path = id.startsWith(".") && importer
            ? resolve(dirname(importer), id) : id;
          if (path.startsWith(src + "/")) return { id: path, moduleSideEffects: true };
        }
      },
      load(id) {
        if (id === entryId) return code;
      },
    }],
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: entryId,
        external: (id) => id === "three" || id.startsWith("three/"),
        // Three.js is the peer dependency; measure only this library's code.
        treeshake: { moduleSideEffects: "no-external" },
        output: { format: "es" },
        preserveEntrySignatures: "strict",
      },
    },
  });
  assert.ok("output" in result);
  const chunk = result.output.find((item) => item.type === "chunk");
  assert.ok(chunk && chunk.type === "chunk");
  return chunk;
}

for (const sourceAudit of [false, true]) {
  const entry = JSON.stringify(sourceAudit ? resolve(src, "index.js") : "three-gtvbao");
  const mode = sourceAudit ? "source statement audit" : "package exports";

  test(`tree shaking: unused library is empty (${mode})`, async () => {
    const chunk = await bundle(`import * as unused from ${entry};`, sourceAudit);
    assert.equal(chunk.code.trim(), "");
    assert.deepEqual(chunk.imports, []);
  });

  test(`tree shaking: constants do not pull in Three.js (${mode})`, async () => {
    const chunk = await bundle(`export { GTVBAO_PASS_NAMES } from ${entry};`, sourceAudit);
    assert.deepEqual(chunk.imports, []);
    assert.deepEqual(chunk.exports, ["GTVBAO_PASS_NAMES"]);
    assert.ok(chunk.code.includes("GTVBAO"));
  });

  test(`tree shaking: AO excludes denoiser and presets (${mode})`, async () => {
    const chunk = await bundle(`export { gtvbao } from ${entry};`, sourceAudit);
    assert.ok(chunk.code.includes("class GTVBAONode"));
    assert.ok(chunk.code.includes("class GTVBAODepthPrefilter"));
    assert.ok(!chunk.code.includes("class GTVBAODenoiseNode"));
    assert.ok(!chunk.code.includes("GTVBAO_PRESETS"));
    assert.ok(!chunk.imports.some((id) => id.includes("SimplexNoise")));
  });

  test(`tree shaking: denoiser excludes AO and prefilter allocation (${mode})`, async () => {
    const chunk = await bundle(`export { gtvbaoDenoise } from ${entry};`, sourceAudit);
    assert.ok(chunk.code.includes("class GTVBAODenoiseNode"));
    assert.ok(!chunk.code.includes("class GTVBAONode"));
    assert.ok(!chunk.code.includes("class GTVBAODepthPrefilter"));
    assert.ok(!chunk.code.includes("gtvbaoFastAcosNorm"));
    // Only the denoiser's own quad should survive the shared helper import.
    assert.equal(chunk.code.match(/new QuadMesh\(/g)?.length, 1);
  });

  test(`tree shaking: linear view helper excludes clip-depth Fn (${mode})`, async () => {
    const helper = JSON.stringify(sourceAudit
      ? resolve(src, "GTVBAOViewSpace.js") : "three-gtvbao/src/GTVBAOViewSpace.js");
    const chunk = await bundle(`export { createPerspectiveViewPositionFromLinearDepth } from ${helper};`, sourceAudit);
    assert.ok(!chunk.code.includes("Fn"));
    assert.ok(!chunk.imports.includes("three/webgpu"));
    assert.deepEqual(chunk.exports, ["createPerspectiveViewPositionFromLinearDepth"]);
  });
}
