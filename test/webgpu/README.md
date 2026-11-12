# WebGPU / WebGL2 regressions

Run `npm run dev`, then open these pages on that server in a WebGPU-capable
browser. Run each page twice: the default URL explicitly requires WebGPU, and
`?backend=webgl` explicitly requires WebGL2. Every page must report a passing result and the browser console must
have no rendering errors.

| Page | Checks | Completion result |
| --- | --- | --- |
| `/test/webgpu/depth-mips.html` | 270 depth-MIP cases against a CPU reference | `window.depthMipRegression` |
| `/test/webgpu/upsample.html` | 14 depth-aware upsample cases | `window.upsampleRegression` |
| `/test/webgpu/temporal.html` | 43 temporal accumulation checks per depth mode (86 rows) | `window.temporalRegression` |
| `/test/webgpu/math.html` | 15,120 shader comparisons against independent references | `window.mathRegression` |
| `/test/webgpu/lighting.html` | Constant-AO lighting against an independent reference | `window.lightingRegression` |
| `/test/webgpu/output-switch.html` | 12 first-frame AO/debug output transitions, including construction, batching, resize and half resolution | `window.outputSwitchRegression` |
| `/test/webgpu/orthographic.html` | 10 scenarios: 8 camera-distance invariance + 2 slice-mode invariance | `window.orthographicRegression` |
| `/test/webgpu/example.html` | 50 display/pass-order and lighting-image scenarios in the production example, raw and accumulated paths | `window.exampleRegression` |

Wait for the completion result before reading it; require `passed === true`.
The requested backend being unavailable is a failure, never a skipped passing case. These
checks are separate from `npm test`: Node tests generate actual WGSL for the
math helpers but cannot execute them on a GPU. Float readback is normalized
to packed top-to-bottom rows on both backends.

## Depth MIPs

An asymmetric depth fixture with a discontinuity checks every texel of all five
MIP levels against a CPU reference. Nine image sizes include odd dimensions,
single-row and single-column targets, 1×1 and 2×2 targets, and even dimensions
whose level 1 texel counts fill a workgroup or require dispatch padding. Each
size receives two distinct depth uploads without reallocating the output targets,
so missing writes cannot hide behind resize clears. The same prefilter survives
resizing and normal → logarithmic → normal depth transitions. Absolute linear-depth error must stay
below `2e-4`; this exposes orientation, edge-clamping, and stale-resource errors.

## Depth-aware upsample

The fixture supplies a known constant-depth plane and nonuniform AO. It runs the
production depth prefilter and public `createDepthAwareAoFromBuffers()` on the
GPU. For this plane, all neighbor depth weights are equal, so a separate hardware
bilinear sample provides the reference without duplicating the upsample math.
Float readback measures maximum error and RMSE; the tolerance is `2e-5` in linear
AO. Images show output, reference, and absolute difference amplified four times.

Cases cover ordinary/logarithmic depth, full/half/quarter resolution, a large
near/far ratio, both normal encodings, disabled depth MIPs, and disabled depth-aware
upsampling. The public helper is always constructed before the AO node's setup.
The result also provides output hashes for comparison with a prior checkout.

## Shader math

One renderer executes the production CDF, slice-direction and view-position
helpers in 22 draws with FloatType readback. The CDF uses three sector measures, both march
directions and asymmetric horizon pairs, including poles, hemisphere boundaries
and values beyond those boundaries. Its reference numerically integrates the
hemisphere density; it does not copy the production closed form or approximate
acos. The angle/cosine tolerances account for the existing acos approximation.

The slice frame is checked against quaternion rotation and orthonormality. Its
screen direction is checked against a finite difference of a real camera's
projection matrix. Each group reports its sample count, maximum error, RMSE,
tolerance and worst case. No JS mirror of the production formula is tested.

View-position probes compare all three reconstruction helpers (UV/depth,
texel/depth, UV/linear depth) with three.js `getViewPosition` and an independent
CPU matrix inverse. Perspective and orthographic cameras sample image corners,
interior pixels, and distances from 0.11 to 100. Orthographic probes use an
asymmetric frustum, zoom 1 and 2.5, and centered/view-offset projections. Relative error
must remain below `2e-4`, including each backend's projection depth convention.

## Orthographic cameras

`orthographic.html` compares actual raw AO and denoised/upsampled GPU output for
a rectangular depth step at camera distances 3 and 13, with a zero near plane. Parallel projection must
preserve both images within `2/255`. The input depths are produced by the
three.js camera projection matrix using binary-exact fixture depths to isolate
camera translation from floating-point sector-boundary rounding. Nonfinite values, out-of-range AO and missing
occlusion also fail. Variants cover world/screen radius, depth MIPs on/off,
full/half resolution, and supplied/depth-derived normals, with the renderer
logarithmic-depth option both off and on. The default distance-scaled thickness
is explicitly disabled because that option intentionally depends on view depth.
That gives 4 scenarios x 2 logarithmic-depth settings = 8 camera-distance entries.

Each logarithmic-depth setting also runs a `slice-mode-invariance` entry (2 total,
10 overall). `usePerspectiveCorrectSlice` only selects the slice distribution for
perspective cameras, so with an orthographic camera the raw AO rendered with it
`true` and `false` (fixed sampling, otherwise identical options) must match to
`1e-6`; the measured maximum difference is reported. Its fixture is a plane tilted
about 29 degrees from the view axis, with supplied normals consistent with its
depth, carrying a raised block. Head-on surfaces would hide a slice-plane normal
computed from the surface normal instead of the view direction, so the
entry also requires real occlusion (minimum AO below 0.98).

Append `?camera=orthographic` to `depth-mips.html` and `upsample.html` to exercise
the existing numerical references with linear orthographic scene depth, including
when the renderer logarithmic-depth flag is on. Append `&backend=webgl` for
WebGL2. The dedicated AO page and `math.html` use `?backend=webgl`. Results are
available as `window.orthographicRegression`, `window.depthMipRegression`,
`window.upsampleRegression`, and `window.mathRegression`.

## Example graph

Run `example.html?camera=orthographic` as well as the default perspective mode.
Use `&backend=webgl` to run its 50 scenarios on WebGL2. Both exercise the
production example with the same AO, denoising, TRAA, and lighting checks.

The page imports the actual example, freezes its camera and animation, and uses
fixed denoiser noise. The example starts with accumulation on and upsample jitter 4, so
every scenario sets `settings.accumulate` and `aoNode.upsampleJitter` itself (false and 0
unless it says otherwise); the original scenarios stay on the raw and denoised sources. Each scenario runs five native frames. The last frame's
backend calls count pre-pass, lit scene, AO, denoising, compute work, and depth
MIP draws. AO frames require one compute pass (containing two dispatches) on WebGPU, or
five depth MIP render passes and zero compute passes on WebGL2;
float output hashes support comparisons across checkouts. The temporal pass
(`GTVBAO_PASS_NAMES.temporal`) is counted too: one per frame when the accumulated source is
rendered, zero otherwise.

The first ten `ui-*` scenarios mirror the public view buttons (full render, AO only
and AO off, with and without denoising) under temporal sampling and TRAA. The
showcase scenarios then exercise denoised + TRAA → AO off → denoised + TRAA to
verify that cached beauty targets remain valid when returning to the initial view.

The last 11 scenarios cover the example's default paths: accumulated + TRAA lit at half
resolution with jitter 4, accumulated lit without TRAA (lighting guards), accumulated AO-only,
accumulated + denoised (lit and AO-only, through the second denoiser
`denoiseAccumulatedNode`), accumulation off then on again returning to cached outputs, and
neutral AO (intensity 0) accumulated and accumulated + denoised at full and half resolution.
The neutral ones apply the same lighting identity checks and require the textures that path
renders (`temporalNode`, and `denoiseAccumulatedNode` when denoising) to be exactly 1. On WebGL2
they fail if the temporal node leaves a half-float history just below 1.

AO/TRAA off → TRAA on → both off must produce pre-pass counts of 0 → 1 → 0,
while still drawing the lit scene once. AO-only and every debug view are checked,
including returning to previously cached outputs. Debug RGB is compared with a
separate read of the exact AO texture rendered in that frame, and must bypass
denoising and TRAA. The comparison occurs before display color conversion.

## Lighting and version compatibility

`lighting.html` renders one sphere with ambient and directional light. The public
upsample helper reads a constant 0.6 AO texture at full resolution, and a separate
scene pass uses `builtinAOContext(float(0.6))` as the independent reference.
The image must match within `2e-5`; the reference center must also be lit, so two
black images cannot pass. `?shaders=1` displays the actual material shaders.
This reproduces the r185 failure without temporal sampling, denoising or AO math.

`output-switch.html` checks the first native frame after selecting an AO/debug
output, using a persistent consumer and the documented variant callback to
rebuild its pipeline. A fresh texture sampler reads the exact producer output
without rerendering AO. All RGBA components must agree within `1e-6`, including
alpha; jitter debug must have distinct color channels. This catches compiling
a debug consumer against a stale RedFormat texture on r186, including when
debug is selected in the constructor. See the [r186 report](../../docs/r186-compatibility.md).

The example compares the first and fifth frame **after each mode switch** for
non-TRAA lighting. This is not a cold-start test of every example mode. Neutral
AO is checked against the same session's AO-off image, with one binary16 ULP
allowed per RGB component because the scene pass uses a half-float target,
and mean luminance ratio must remain within `1e-5` of unity. The raw and rendered
denoised AO textures must also be neutral. Regular AO must retain at least half
the reference luminance in the central region, with at most 10% of those pixels
darkened by over 95%. These are blackening guards, not AO quality scores.
TRAA cases retain the existing pass-count and finite-output checks.

To run identical code against a different Three.js version without changing the
project's dependencies:

```sh
npm install --prefix /tmp/gtvbao-r185 --no-save three@0.185.1
THREE_ROOT=/tmp/gtvbao-r185/node_modules/three PORT=5193 node test/webgpu/serve-version.mjs
```

Run the same pages at port 5193 and at the regular development server. Repeat
with `?backend=webgl`. The version server aliases all `three`, `three/webgpu`,
`three/tsl`, addons and example imports together. Use fresh page loads after
source changes. [The r185.1 investigation](../../docs/r185-lighting-regression.md)
records the observed failure, generated shader cause, and verification scope.

## Temporal accumulation

`temporal.html` drives the public `gtvbaoTemporal()` node through its real `setup()` and
`updateBefore()` on a 16×16 AO/depth/velocity fixture (synthetic textures, a camera with a
rotated, offset pose) and reads the half-float output back through a probe. It runs once with
the normal and once with the logarithmic depth buffer. Each row is a maximum absolute error
against a tolerance (`HALF = 3e-3` covers half-float storage; history lengths allow 0.1).
Unless a case is about the clamp, `clampSigma` is 1000 and the current frame has a little
spatial variation, because a flat neighborhood has sigma 0 and pins the history by itself.

- First frame equals the input and stores the linear depth; history length grows by one per
  frame and survives non-consecutive frame ids (a paused loop).
- Alternating AO images converge to their mean within `blend * |A-B| / (2 * (2 - blend))`
  (the analytic ripple of the filter) plus the half-float margin, for perspective,
  orthographic and depth-derived normals; `blend = 1` equals the current input.
- Depth jumping by 10 (far more than the 2-texel plane tolerance) rejects the history; a
  change of 0.2 keeps it. Both camera types.
- Whole-texel velocity along x and along y keeps a high-contrast pattern sharp and restarts
  the texels entering from outside; a real camera dolly keeps the history only if the
  reprojection matrix maps the previous view space into the current one. Velocities come from
  the camera matrices in the page, not from the library.
- A flat 3×3 neighborhood passes through bit-exact (zero tolerance): constant AO 1 and 0.75,
  with the same history or a different one (0.9), sub-texel velocity in both axes so all four
  history taps carry non-trivial weights, five frames. WebGL2 fails without the explicit
  flat-neighborhood select; WebGPU does not.
- `reset()` makes the next frame equal the input; the neighborhood clamp holds the history
  to mean ± `clampSigma`·σ of the current 3×3 (checked against an independent CPU value).
- `parallaxBlend`: translation raises the current-frame weight by `parallaxBlend` times the
  sine of the view-ray angle, pure rotation and `parallaxBlend = 0` do not.

In a hidden Browser pane, WebGL readback waits on `requestAnimationFrame`. If a page stalls
there, load it in an iframe and replace the iframe's `requestAnimationFrame` with a version
paced by a Worker timer (a message-channel loop alone spins and starves the GPU fence).

## Temporal flicker measurement

`flicker.html` is a measurement page, not a pass/fail regression. It drives the production
example with a frozen scene and TRAA, reads back every measured frame as float, and reports
per case how much the image changes over time. Results are in `window.flickerRegression`
(`tableTsv` is the same table as tab-separated text).

Per-pixel temporal standard deviation does not separate a steady image from a flickering
one: at reduced AO resolution the noise is spatially correlated, and that is what the eye
sees. The page therefore also box-filters each frame (`blurs`, default `1,4,8` pixels) before
taking the statistics; compare `std@4` and `delta@4` (mean frame-to-frame change).

| Parameter | Default | Meaning |
| --- | --- | --- |
| `size` | `960x540` | Render size. |
| `view` | `detail` | Camera view of the example (`overview` or `detail`). |
| `scales` | `1,0.75,0.5,0.25` | AO resolution scales to measure. |
| `denoise` | `0` | Comma list of `0`/`1`: without and/or with the spatial denoiser. |
| `only` | `1` | `1` measures the AO-only view, `0` the lit image (adds an `ao-off` baseline). |
| `preset` | `Balanced` | Preset applied before each case. |
| `warmup`, `frames` | `48`, `48` | Frames rendered before measuring, and measured. Use `warmup=200` for converged TRAA history. |
| `variants` | one empty variant | JSON array of `{ label, ao?, denoiser?, settings?, targets? }` compared in one run: options for the AO node, the denoiser, the example's `settings`, and any object exported by `example/main.ts` by export name. |
| `orbit` | `0` | Degrees per frame the camera orbits its target; every case sees the same path. |
| `ref` | absent | JSON AO options of a reference case (rendered first, at scale 1 unless it sets `resolutionScale`). Each case then reports `err@k`: the mean absolute box-filtered difference to the reference frame by frame. |

Example: accumulation on and off at half resolution, static and while orbiting, against an
eight-slice reference at the same resolution:

```
flicker.html?only=0&warmup=200&frames=64&scales=0.5&variants=[{"label":"base"},{"label":"acc","settings":{"accumulate":true}}]
flicker.html?only=0&warmup=60&frames=48&scales=0.5&orbit=0.3&ref={"sliceCount":8,"resolutionScale":0.5}&variants=[{"label":"base"},{"label":"acc","settings":{"accumulate":true}}]
```

The page pauses the animation loop around every readback, so three's `frameId` is not
consecutive across measured frames.
