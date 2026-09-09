# Three.js 0.186.0 compatibility check

2026-09-09. Applied `three@^0.186.0`, locked to 0.186.0. The user authorized
an exception to the seven-day release-age policy for this install:
`npm install --save-dev three@^0.186.0 --min-release-age=0 --ignore-scripts`.
The repository `.npmrc` remains unchanged.

## Result after fixing output selection timing

The in-app browser executed these tests against the installed 0.186.0 package,
using `PORT=5196 node test/webgpu/serve-version.mjs`.
The initial failures are retained in [r186-results.json](verification/r186-results.json).
Final page results are in [r186-fixed-results.json](verification/r186-fixed-results.json).

| Test | WebGPU | WebGL2 |
| --- | --- | --- |
| Constant-AO lighting | PASS, max error 0 | PASS, max error 0 |
| Production example, perspective | 39/39 | 39/39 |
| Production example, orthographic | 39/39 | 39/39 |
| Output switching, first frame | 12/12, max RGBA error 0 | 12/12, max RGBA error 0 |
| Depth MIPs | 270/270 | 270/270 |
| Upsample | 14/14 | 14/14 |
| Shader math | 15,120 comparisons PASS | 15,120 comparisons PASS |
| Orthographic AO | 8/8 | 8/8 |

Before the fix, the production example failed `debug-1` and `debug-return`, with maximum RGBA
errors approximately 0.98 and 1.0 against the actual AO texture. Pass counts
were correct; browser rendering warnings/errors were absent. Regular lighting,
neutral AO, and the remaining display transitions passed.

For a same-source control, 0.184.0 was separately installed under
`/tmp/gtvbao-r184` and served with `THREE_ROOT` on port 5194. Its WebGPU
production example passed 39/39. Thus the failed transitions are a regression
with r186, not merely an already-failing test at the previous dependency version.

## Cause and fix

The initial report suspected texture binding generation collisions. That hypothesis
was incorrect: `Sampler.texture` calls `reset()` on an identity change, clearing
the generation. The failure is shader type inference, not that binding condition.

In r186, `TextureNode.generateNodeType()` uses `getTextureType()`: RedFormat is
`float`, while RGBAFormat is `vec4`. r184 returned `vec4` for both. The AO node
used to publish the newly selected texture only at the end of `updateBefore()`.
Consumer shaders compiled earlier, while the output still referred to the old
format. A debug shader compiled against RedFormat therefore discarded channels,
even after the correct RGBA texture was bound.

A minimal diagnostic reproduced this without AO, resizing, or temporal effects:
a persistent sample changed from a Red target to an RGBA target containing
`(0.2, 0.6, 0.8, 1)`. The stale scalar shader returned `(0.2, 0.2, 0.2, 0.2)`.
Rebuilding after selecting the RGBA texture returned the full expected vector.

`GTVBAONode` now selects the initial texture from `debugMode`, and publishes
subsequent selections before rebuilding the AO material or notifying consumer
callbacks, including during batched changes. The late assignment in
`updateBefore()` is removed. The documented consumer callback still invalidates
the pipeline after variant changes. No new API, renderer patch, or additional
render pass is needed; normal AO keeps its compact RedFormat target.

Two Node tests cover initial debug construction and consumer callback timing.
The focused `output-switch.html` fixture keeps one consumer across mode changes
and compares its **first native frame** with a fresh ordinary texture sampler of
the exact producer output. All RGBA components must match within `1e-6`; finite
values and a colored jitter reference prevent a blank-image false pass. Cases
cover initial debug modes, repeated round trips, batches, resizing, and half
resolution. The original example also passes 39/39 on both backends with r184.

As a negative control, the source fix was temporarily removed: the focused GPU
fixture failed 11/12 cases on each backend (maximum RGBA error 1). Restoring the
fix returned both to 12/12 with zero error. These failures are retained in
[r186-output-switch-before.json](verification/r186-output-switch-before.json),
and the final restored-source run in
[r186-output-switch-after.json](verification/r186-output-switch-after.json).

## Node checks and changes

The initial r186 unit run failed six tests because internal builder APIs changed.
Tests now consume `builder.nodes` through `Array.from` (r186 uses a Set), and
the arithmetic WGSL fixture supplies the renderer's default diagnostics setting.
Assertions and tolerances were not weakened.

- `npm run typecheck`: PASS.
- `npm test`: PASS, 12 files / 53 tests.
- `npm run build`: PASS.
- `npm run lint`: unavailable, no lint script is defined.

`@types/three` remains at the existing 0.184-series dependency; typechecking is
not evidence of complete r186 declaration coverage. Additional orthographic
variants of the depth-MIP and upsample pages, other hardware, and pixel parity
of TRAA lighting were not checked here. The r186 dependency and fix remain
applied in the working tree.
