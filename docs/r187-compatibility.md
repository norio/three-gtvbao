# Three.js 0.187.0 compatibility check

2026-11-12. Applied `three@^0.187.0`, locked to 0.187.0 (published 2026-10-30,
inside the repository's seven-day release-age policy, so no exception was needed).
`@types/three` stays on the 0.184 series, the minimum supported version.

## Result

The library needed one change; the GPU regression harness needed another.

| Test | WebGPU | WebGL2 |
| --- | --- | --- |
| Constant-AO lighting | PASS | PASS |
| Production example, perspective | 39/39 | 39/39 |
| Production example, orthographic | 39/39 | 39/39 |
| Output switching, first frame | 12/12 | 12/12 |
| Depth MIPs | 270/270 | 270/270 |
| Upsample | 14/14 | 14/14 |
| Shader math | 15,120 comparisons PASS | 15,120 comparisons PASS |
| Orthographic AO | 10/10 | 10/10 |

No rendering warnings or errors were logged on the final runs.

## Library change: `TempNode` is deprecated

r187 folded `TempNode`'s temporary-variable caching into `Node` and deprecated
`TempNode`; its constructor now logs "THREE.TempNode: This module has been
deprecated. Extend Node instead." `GTVBAONode` and `GTVBAODenoiseNode` extended
`TempNode`, so every construction warned.

Both now extend `GTVBAONodeBase` (`src/GTVBAONodeBase.js`), which is `Node` on
r187 and later and `TempNode` on r184–r186, where `TempNode` still provides the
caching. Behavior on the older revisions is therefore unchanged. The type
declarations name `Node` as the base class.

## Harness change: WebGPU readback is tightly packed

Before the fix, `depth-mips.html` failed 150/270 and `math.html` failed its three
slice groups, on WebGPU only. Neither is a rendering regression. r187 changed
`readRenderTargetPixelsAsync` on WebGPU to strip the 256-byte row padding that
r184–r186 return, and `readFloatTarget()` in `test/webgpu/backend.ts` still read
rows at the padded stride. Only readbacks at least two rows high whose width is
not a multiple of 16 were affected, which is why the other pages passed.

The generated WGSL for the slice probe is equivalent on r186 and r187, and the
depth MIPs are correct once the readback is unpacked properly. `readFloatTarget()`
now detects the layout from the returned length, so the same harness runs on
r184–r187. A Node test (`test/ReadFloatTarget.test.ts`) covers the padded,
packed and WebGL layouts.

## Checks

- `npm run typecheck`, `npm test` (15 files / 85 tests), `npm run build`: PASS.
- The unit tests also pass against separately installed 0.184.0 and 0.186.0
  (tree-shaking tests excluded), including the `TempNode` branch of
  `GTVBAONodeBase`.
- With the readback fix, `depth-mips.html` passes 270/270 on WebGPU against
  0.186.0 as well.

Not re-run in a browser against 0.184.0 and 0.185.1: the remaining GPU pages.
Other hardware and pixel parity between revisions were not checked.
