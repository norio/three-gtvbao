# three-gtvbao

![GT-VBAO ambient occlusion showcase](docs/cover.webp)

**English | [日本語](README.ja.md)**

GT-VBAO screen-space ambient occlusion for [three.js](https://threejs.org/) WebGPU and WebGL2, written in TSL.

Based on three.js's `SSGINode` AO path and `DenoiseNode`, with Mirko Salm's GT-VBAO corrections.
It applies AO to indirect lighting through `builtinAOContext` and `RenderPipeline`.

- Visibility bitmasks with cosine-weighted sectors and perspective-correct slice directions.
- Linear-depth MIPs, reduced-resolution rendering and depth-aware upsampling to reduce edge bleeding.
- Temporal sampling with TRAA, or fixed sampling with an edge-aware denoiser.
- Five quality presets, debug views and TypeScript declarations.
- Native ESM with tree shaking; import only the named exports you need. Runtime options do not remove bundled code.

## Live demo

[Open the demo](https://norio.github.io/three-gtvbao/) to explore the presets and AO controls.
The active backend is shown in the demo; [force WebGL2](https://norio.github.io/three-gtvbao/?backend=webgl) to try that backend.

## Requirements

- three.js **r184** or newer (`three/webgpu` and `three/tsl`).
- `WebGPURenderer` with its WebGPU or WebGL2 backend; the legacy `WebGLRenderer` is unsupported.
- `EXT_color_buffer_float` when using WebGL2.
- A `PerspectiveCamera`.

## Install

```bash
npm install three three-gtvbao
```

## Quick start

Start with an initialized `WebGPURenderer`, a `scene` and a perspective `camera`.
The opaque pre-pass provides depth and normals; the lit pass applies AO to materials that use
three.js's AO lighting hook, such as `MeshStandardNodeMaterial`. Unlit materials are unaffected.

```js
import * as THREE from "three/webgpu";
import { builtinAOContext, mrt, normalView, pass, positionView, screenUV, velocity } from "three/tsl";
import { traa } from "three/examples/jsm/tsl/display/TRAANode.js";
import { gtvbao, applyGtvbaoPreset, renderPassAfter, createPassthroughAoContext } from "three-gtvbao";

// 1. Opaque pre-pass: depth, view-space normals and velocity for TRAA.
const prePass = pass(scene, camera);
prePass.transparent = false;
prePass.setMRT(mrt({ output: normalView, velocity }));
prePass.contextNode = createPassthroughAoContext();
const preNormal = prePass.getTextureNode("output");
const preDepth = prePass.getTextureNode("depth");
const preVelocity = prePass.getTextureNode("velocity");

// 2. AO reads the completed pre-pass.
const aoNode = gtvbao(preDepth, preNormal, camera);
applyGtvbaoPreset(aoNode, "Balanced");
renderPassAfter(aoNode, prePass);

// 3. Apply AO at each lit fragment's surface.
const scenePass = pass(scene, camera);
renderPassAfter(scenePass, prePass);
scenePass.contextNode = builtinAOContext(
  aoNode.createDepthAwareAo(aoNode.getTextureNode(), {
    screenUv: screenUV,
    viewPosition: positionView,
    viewNormal: normalView,
  })
);

// 4. Resolve temporal sampling with TRAA.
const pipeline = new THREE.RenderPipeline(renderer);
pipeline.outputNode = traa(scenePass, preDepth, preVelocity, camera);
aoNode.setVariantChangeCallback(() => {
  pipeline.needsUpdate = true;
});

renderer.setAnimationLoop(() => pipeline.render());
```

Keep the `renderPassAfter` calls and the pre-pass's `createPassthroughAoContext()`:
they ensure the depth inputs are ready and prevent the lit pass's AO hook from affecting the pre-pass.
The variant callback updates the pipeline when settings change the compiled shader.

### Without temporal anti-aliasing

Before starting the render loop, use a `No Temporal` preset, feed the denoised texture to the
lit pass, and replace the TRAA output with the scene pass:

```js
import { gtvbaoDenoise } from "three-gtvbao";

const denoiseNode = gtvbaoDenoise(aoNode.getTextureNode(), preDepth, preNormal, camera, {
  linearDepthSource: aoNode,
});
renderPassAfter(denoiseNode, aoNode);
applyGtvbaoPreset(aoNode, "No Temporal Low", denoiseNode);

scenePass.contextNode = builtinAOContext(
  aoNode.createDepthAwareAo(denoiseNode.getTextureNode(), {
    screenUv: screenUV,
    viewPosition: positionView,
    viewNormal: normalView,
  })
);
pipeline.outputNode = scenePass;
```

## Presets

| Preset | Resolution scale | Slices × steps | Temporal | Denoise |
| --- | --- | --- | --- | --- |
| `Low` | 0.5 | 1 × 8 | yes | no |
| `Balanced` | 0.5 | 2 × 6 | yes | no |
| `High` | 1 | 3 × 12 | yes | no |
| `No Temporal Low` | 0.5 | 2 × 6 | no | yes |
| `No Temporal High` | 1 | 3 × 12 | no | yes |

`applyGtvbaoPreset(aoNode, presetOrName, denoiseNode?)` applies settings and returns the resolved
preset. It does not wire the render graph: temporal presets need TRAA or another temporal resolve;
denoising presets need the denoiser's output connected as above.
`DEFAULT_GTVBAO_PRESET` is `"Balanced"`; available names and settings are in
`GTVBAO_PRESET_NAMES` and `GTVBAO_PRESETS`.

## API

### `gtvbao(depthNode, normalNode, camera, options?)`

Also available as `new GTVBAONode(...)`. Pass a pre-pass depth texture node, a view-space normal
texture node (or `null` to reconstruct normals from depth), and a `PerspectiveCamera`.
Logarithmic depth buffers are supported. `options` accepts initial values for the properties below.

Defaults here are constructor defaults, before applying a preset. Set `plain` properties directly
and `uniform` / `variant` properties through `.value`. Variant changes can rebuild the shader;
`batchVariantChanges(fn)` groups them into one rebuild. Set `normalEncoding` at construction.

| Property | Kind | Default | Description |
| --- | --- | --- | --- |
| `resolutionScale` | plain | `1` | AO resolution relative to the drawing buffer. |
| `sliceCount` | variant | `2` | Slices per pixel (1–8). |
| `stepCount` | variant | `8` | Steps per direction (1–32); up to `sliceCount × stepCount × 2` samples per pixel. |
| `radius` | uniform | `3` | Sampling radius control; screen-relative by default, world-space when `useScreenSpaceSampling` is false. |
| `useScreenSpaceSampling` | variant | `true` | Choose screen-relative rather than world-space sampling radius. |
| `thickness` | uniform | `0.12` | Base occluder thickness in world units, before depth scaling and clamping. |
| `useLinearThickness` | variant | `true` | Scale thickness with sample view depth relative to `camera.far`. |
| `linearThicknessScale` | uniform | `100` | Multiplier for depth-scaled thickness. |
| `maxThickness` | uniform | `0.35` | Maximum effective thickness and depth range for the MIP prefilter. |
| `aoIntensity` | variant | `1` | Visibility exponent; rebuilds only when entering or leaving the `1` fast path. |
| `expFactor` | variant | `2` | Step distribution exponent; rebuilds only when entering or leaving the `2` fast path. |
| `sectorMeasure` | variant | `"cosine"` | Sector weighting: `"cosine"`, `"solidAngle"` or `"angle"`; see below. |
| `usePerspectiveCorrectSlice` | variant | `true` | Distribute slices around the view vector and project them to the screen. |
| `useDepthMips` | variant | `true` | Sample the linear-depth MIP chain instead of scene depth. |
| `useDepthAwareUpsample` | plain | `true` | Enable depth-aware upsampling when `resolutionScale < 1` and depth MIPs are enabled. |
| `useTemporalFiltering` | plain | `true` | Rotate samples each frame; requires a temporal resolve. |
| `normalEncoding` | plain | `"view"` | Raw view-space normals, or `"directionToColor"` for normals packed into `[0,1]`. |
| `debugMode` | variant | `0` | Select a view from `GTVBAO_DEBUG_MODE_OPTIONS`. |

| Method | Description |
| --- | --- |
| `getTextureNode()` | AO texture; use `createDepthAwareAo` for depth-aware upsampling. |
| `createDepthAwareAo(aoTexture, { screenUv, viewPosition, viewNormal })` | Sample AO at a lit fragment using its own `positionView` and `normalView`. |
| `createDepthAwareAoFromBuffers(aoTexture, depthTexture, normalTexture, screenUv)` | Equivalent for a full-screen pass, reconstructing the surface from buffers. |
| `getDepthMipNodes()` | Five linear-depth textures; level 0 is at AO resolution. Updated only while depth MIPs are enabled. |
| `isDepthAwareUpsampleActive()` | Whether reduced resolution and the current settings enable depth-aware upsampling. |
| `setVariantChangeCallback(fn)` | Register the pipeline update callback shown above. |
| `batchVariantChanges(fn)` | Apply multiple variant changes with one rebuild. |
| `setSize(width, height)` | Called automatically with the drawing buffer size. |
| `dispose()` | Release the node's render targets, materials and depth prefilter. |

### `gtvbaoDenoise(aoTexture, depthNode, normalNode, camera, options?)`

Also available as `new GTVBAODenoiseNode(...)`. A 16-tap edge-aware denoiser that runs at AO
resolution. `getTextureNode()` returns its output; `dispose()` releases its resources.

Adjust `radius` (AO texels), `lumaPhi`, `depthPhi` and `normalPhi` through `.value`.
Options are `normalEncoding`, `linearDepthSource` (an AO node whose linear depth can be reused),
and `useTemporalDenoiseRotation` (rotate the kernel each frame; use only with a temporal resolve).

### Pass ordering and exports

`renderPassAfter(passNode, dependency)` renders the dependency first each frame.
`createPassthroughAoContext()` isolates the opaque pre-pass from the lit pass's AO context.
See the quick start for their placement.

For all exports, including debug helpers, sector measures and render-pass names for timestamp
queries, see [src/index.js](src/index.js) and the [TypeScript declarations](src/index.d.ts).

## Algorithm and limitations

Each slice tracks occluded directions in a 32-bit mask. GT-VBAO remaps horizon angles before
quantization, uses shared dithering for both sector edges, and distributes slices around the
per-pixel view vector. Clear sectors determine visibility; cosine-weighted slices are combined
using their integral weights.

- `cosine` uses GTAO-style weighting to reduce camera-pitch bias. `solidAngle` uses solid-angle
  weighting; `angle` keeps the original equal-angle VBAO sectors.
- `cosine` can be noisier in dark regions at the same sample count. Try `angle` if lower noise
  matters more than reducing pitch bias.
- AO uses screen-space depth, so hidden or off-screen geometry cannot contribute.
- Thickness is an approximation; the perspective-correct offset along each sample's own view ray is not implemented.

## Development

In a repository checkout, use Node.js **20+**:

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

Open the local URL printed by Vite (normally `http://localhost:5173`). The [example](example/)
shows the active backend; append `?backend=webgl` to force WebGL2. In your app, use
`new THREE.WebGPURenderer({ forceWebGL: true })`; otherwise WebGL2 is selected when WebGPU is unavailable.

`npm test` includes the tree-shaking checks; `npm run test:treeshake` runs those alone.
Browser GPU checks are separate: see [WebGPU / WebGL2 regressions](test/webgpu/README.md).

The example is published to GitHub Pages by [GitHub Actions](.github/workflows/ci.yml)
after each push to `master`. The Pages build uses `npm run build -- --base=/three-gtvbao/`
and publishes `dist/`.

## Credits

- Based on three.js's [`SSGINode.js`](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/tsl/display/SSGINode.js)
  and `DenoiseNode.js` (MIT). `SSGINode` is a port of Olivier Therrien's
  [SSRT3](https://github.com/cdrinmatane/SSRT3) (MIT), from *Screen Space Indirect Lighting
  with Visibility Bitmask* (Therrien, Levesque, Gilet, 2023).
- GT-VBAO corrections: [Mirko Salm's Shadertoy](https://www.shadertoy.com/view/XXGSDd) (CC0 / MIT).
- Depth MIP prefilter: Intel's [XeGTAO](https://github.com/GameTechDev/XeGTAO) (MIT).

## License

[MIT](LICENSE)
