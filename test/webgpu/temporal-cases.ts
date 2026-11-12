import * as THREE from "three/webgpu";
import { COUNT, Rig, SIZE, type RigOptions, type Texels } from "./temporal-rig.js";

// Half-float targets hold AO and history: values in [0, 1] carry about 5e-4 of
// rounding per store, so every blended expectation gets this margin.
const HALF = 3e-3;
// History length is a weighted mean of integers stored in half float (steps of 2^-7 above 8),
// and neighbor taps carry rounding-level weights; counts differ by whole frames when wrong.
const COUNT_TOL = 0.1;
const D = 10;
const BASE_ALPHA = 0.1; // default blend: 1 / (n + 1) is below it once n >= 10

export type Check = { label: string; error: number; tolerance: number };
export type CaseContext = { renderer: THREE.WebGPURenderer };
export type Case = { name: string; run(context: CaseContext): Promise<Check[]> };

const aoA = (x: number, y: number) => ((x * 5 + y * 3) % 16) / 32 + 0.25; // multiples of 1/32: exact in half float
const aoB = (x: number, y: number) => 1 - aoA(x, y);
// A current frame with a little spatial variation: on a flat neighborhood sigma is 0 and the
// clamp would pin the history to the current value whatever clampSigma is.
const slight = (x: number, y: number) => 0.1 + ((x + y) % 2) * 0.02;
const slightAt = (i: number) => slight(i % SIZE, Math.floor(i / SIZE));
const blendOld = (current: number, alpha = BASE_ALPHA) => 0.9 * (1 - alpha) + current * alpha;
const indices = (x0: number, x1: number, y0 = 0, y1 = SIZE) =>
  Array.from({ length: COUNT }, (_, i) => i).filter(i => i % SIZE >= x0 && i % SIZE < x1 && Math.floor(i / SIZE) >= y0 && Math.floor(i / SIZE) < y1);

function compare(label: string, actual: Float32Array, expected: number | ((i: number) => number), tolerance: number, texels = indices(0, SIZE)): Check {
  let error = 0;
  for (const i of texels) {
    const want = typeof expected === "number" ? expected : expected(i);
    error = Math.max(error, Number.isFinite(actual[i]) ? Math.abs(actual[i] - want) : Infinity);
  }
  return { label, error, tolerance };
}

async function withRig<T>(context: CaseContext, options: RigOptions, body: (rig: Rig) => Promise<T>) {
  const rig = new Rig(context.renderer, options);
  try {
    return await body(rig);
  } finally {
    rig.dispose();
  }
}

/** Frames of a static scene, so the history reaches `frames` accumulated frames. */
function settle(rig: Rig, frames: number, ao: (x: number, y: number) => number, distance: number | ((x: number, y: number) => number) = D) {
  rig.setAo(ao);
  rig.setDistance(distance);
  rig.setVelocity(() => [0, 0]);
  for (let frame = 0; frame < frames; frame++) rig.step(frame);
}

const cameras: Array<[string, RigOptions]> = [
  ["perspective", {}], ["orthographic", { orthographic: true }], ["depth-derived normals", { depthNormal: true }],
];

const firstFrame: Case = {
  name: "first frame, history length, paused loop",
  run: ({ renderer }) => withRig({ renderer }, {}, async rig => {
    rig.setAo(aoA);
    rig.setDistance(D);
    rig.setVelocity(() => [0, 0]);
    const checks: Check[] = [];
    // Non-consecutive frame ids (an application pausing and resuming its loop) keep the history.
    for (const [i, frameId] of [0, 1, 100, 101].entries()) {
      rig.step(frameId);
      const out = await rig.read();
      if (i === 0) {
        checks.push(compare("first frame equals the input (AO)", out.ao, j => aoA(j % SIZE, Math.floor(j / SIZE)), 1e-4));
        checks.push(compare("first frame stores the linear depth", out.depth, D, 0.02));
      }
      checks.push(compare(`history length after frame ${i + 1} (id ${frameId})`, out.count, i + 1, COUNT_TOL));
    }
    return checks;
  }),
};

const converge = (name: string, options: RigOptions, blend: number): Case => ({
  name,
  run: ({ renderer }) => withRig({ renderer }, { ...options, blend }, async rig => {
    rig.setDistance(D);
    rig.setVelocity(() => [0, 0]);
    const frames = 80;
    for (let frame = 0; frame < frames; frame++) {
      rig.setAo(frame % 2 ? aoB : aoA);
      rig.step(frame);
    }
    const out = await rig.read();
    // An exponential filter fed A, B, A, B... settles on outputs whose mean is exactly
    // (A+B)/2 and which differ from each other by blend * |A-B| / (2 - blend).
    const spread = (blend * 0.5) / (2 * (2 - blend));
    return [compare(`output within ${spread.toFixed(4)} + half-float margin of the mean (blend ${blend})`, out.ao, 0.5, spread + HALF)];
  }),
});

const blendOne: Case = {
  name: "blend 1 equals the current input",
  run: ({ renderer }) => withRig({ renderer }, { blend: 1 }, async rig => {
    rig.setDistance(D);
    rig.setVelocity(() => [0, 0]);
    for (let frame = 0; frame < 12; frame++) {
      rig.setAo(frame % 2 ? aoB : aoA);
      rig.step(frame);
    }
    const out = await rig.read();
    return [compare("output equals the last input", out.ao, i => aoB(i % SIZE, Math.floor(i / SIZE)), 1e-4)];
  }),
};

const depthChange = (name: string, options: RigOptions): Case => ({
  name,
  run: ({ renderer }) => withRig({ renderer }, options, async rig => {
    settle(rig, 10, () => 0.9);
    // Texel footprint at distance 10 is about 0.65; the plane tolerance is two footprints (about 1.3).
    rig.setDistance(x => (x < 5 ? 20 : x < 11 ? D + 0.2 : D));
    rig.setAo(slight);
    rig.step(10);
    const out = await rig.read();
    const blended = (i: number) => blendOld(slightAt(i));
    const [rejected, nearly, same] = [indices(0, 5), indices(5, 11), indices(11, SIZE)];
    return [
      compare("depth jump of 10: history rejected, output equals the current frame", out.ao, slightAt, 1e-4, rejected),
      compare("depth jump of 10: history length restarts", out.count, 1, COUNT_TOL, rejected),
      compare("depth jump of 10: stores the new linear depth", out.depth, 20, 0.02, rejected),
      compare("depth change of 0.2 stays within the plane tolerance: history blended", out.ao, blended, HALF, nearly),
      compare("depth change of 0.2: history length continues", out.count, 11, COUNT_TOL, nearly),
      compare("unchanged depth: history blended", out.ao, blended, HALF, same),
    ];
  }),
});

const reset: Case = {
  name: "reset() drops the history",
  run: ({ renderer }) => withRig({ renderer }, {}, async rig => {
    settle(rig, 10, () => 0.9);
    rig.setAo(slight);
    rig.temporal.reset();
    rig.step(10);
    const out = await rig.read();
    return [compare("frame after reset() equals the input", out.ao, slightAt, 1e-4), compare("history length restarts", out.count, 1, COUNT_TOL)];
  }),
};

// The column pattern has 16 distinct values, so any wrong shift changes every texel.
const column = (x: number) => ((x * 7) % 16) / 16;
const row = (y: number) => ((y * 7) % 16) / 16;

const shift = (name: string, axis: "x" | "y"): Case => ({
  name,
  run: ({ renderer }) => withRig({ renderer }, {}, async rig => {
    const frames = 12;
    const pattern = axis === "x" ? column : row;
    // The pattern moves one AO texel per frame: right for x, up for y (velocity Y points up).
    // That is 2 / SIZE of NDC; the history of a texel is the previous texel opposite to the motion.
    const velocity: [number, number] = axis === "x" ? [2 / SIZE, 0] : [0, 2 / SIZE];
    rig.setDistance(D);
    rig.setVelocity(() => velocity);
    for (let frame = 0; frame < frames; frame++) {
      rig.setAo((x, y) => axis === "x" ? pattern((x - frame + 64) % SIZE) : pattern((y + frame) % SIZE));
      rig.step(frame);
    }
    const out = await rig.read();
    const coordinate = (i: number) => axis === "x" ? i % SIZE : Math.floor(i / SIZE);
    const entering = (i: number) => axis === "x" ? coordinate(i) === 0 : coordinate(i) === SIZE - 1;
    const want = (i: number) => axis === "x" ? pattern((coordinate(i) - (frames - 1) + 64) % SIZE) : pattern((coordinate(i) + frames - 1) % SIZE);
    return [
      compare("pattern moving one texel per frame stays sharp (equals the input)", out.ao, want, 1e-3),
      // A texel's chain of history starts where the pattern entered the image.
      compare("history follows the motion: length grows along the chain", out.count, i => Math.min(axis === "x" ? coordinate(i) + 1 : SIZE - coordinate(i), frames), COUNT_TOL),
      compare("texels entering from outside the history restart", out.count, 1, COUNT_TOL, indices(0, SIZE).filter(entering)),
    ];
  }),
});

const dolly: Case = {
  name: "camera dolly keeps history through the reprojection matrix",
  run: ({ renderer }) => withRig({ renderer }, {}, async rig => {
    settle(rig, 10, () => 0.9);
    // Moving 4 units forward makes the surface 6 away; its previous position, carried into the new view,
    // is on the new surface only if the matrix maps previous view space to the current one.
    const previousWorld = rig.moveCamera(camera => camera.translateZ(-4));
    rig.setDistance(6);
    rig.setVelocity(rig.motionSince(previousWorld, () => 6));
    rig.setAo(slight);
    rig.step(10);
    const out = await rig.read();
    const center = indices(5, 11, 5, 11);
    return [
      compare("history carried across the dolly: blended with the old AO", out.ao, i => blendOld(slightAt(i)), HALF, center),
      compare("history length continues across the dolly", out.count, 11, COUNT_TOL, center),
    ];
  }),
};

// Clamp is the subject here; every other case sets clampSigma large.
const clamp: Case = {
  name: "neighborhood clamp",
  run: async ({ renderer }) => {
    // Flat current neighborhood: sigma is 0, so the old 0.9 is clamped onto the current value.
    const flat = await withRig({ renderer }, { clampSigma: 1.5 }, async rig => {
      settle(rig, 10, () => 0.9);
      rig.setAo(() => 0.1);
      rig.step(10);
      return rig.read();
    });
    // Alternating columns: the 0.9 history is held to mean + 1.5 sigma of the current 3x3 neighborhood.
    const current = (x: number): number => (x % 2 ? 0.4 : 0.2);
    const varying = await withRig({ renderer }, { clampSigma: 1.5 }, async rig => {
      settle(rig, 10, () => 0.9);
      rig.setAo((x) => current(x));
      rig.step(10);
      return rig.read();
    });
    const at = (x: number) => current(Math.min(SIZE - 1, Math.max(0, x)));
    const expected = (i: number) => {
      const x = i % SIZE;
      const values = [x - 1, x, x + 1].map(at);
      const mean = values.reduce((a, b) => a + b) / 3;
      const sigma = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / 3);
      return (mean + 1.5 * sigma) * (1 - BASE_ALPHA) + current(x) * BASE_ALPHA;
    };
    return [
      compare("flat neighborhood: history clamped to the current value", flat.ao, 0.1, HALF),
      compare("varying neighborhood: history held to mean + 1.5 sigma", varying.ao, expected, HALF),
    ];
  },
};

// A flat 3x3 neighborhood has no spatial information to protect, so the output must be the current
// value bit for bit: no tolerance. The velocity is a sub-texel shift in both axes, so every history
// lookup blends four taps with non-trivial weights (the sum of weights times the value, divided by
// the weight sum, is where a rounding error of one ulp below the value comes from). The history is
// the same constant, or a different one that the flat neighborhood must discard at once. Values are
// exact in half float, the storage format, and the check covers each of the five frames after the history was built.
const flatPassThrough = (value: number, history: number): Case => ({
  name: `flat neighborhood passes through bit-exact (AO ${value}, history ${history})`,
  run: ({ renderer }) => withRig({ renderer }, {}, async rig => {
    rig.setDistance(D);
    rig.setVelocity(() => [(0.3 * 2) / SIZE, (0.45 * 2) / SIZE]);
    rig.setAo(() => history);
    for (let frame = 0; frame < 4; frame++) rig.step(frame);
    rig.setAo(() => value);
    let error = 0;
    for (let frame = 4; frame < 9; frame++) {
      rig.step(frame);
      error = Math.max(error, compare("", (await rig.read()).ao, value, 0).error);
    }
    return [{ label: "five flat frames: output equals the input exactly (max error over all texels and frames)", error, tolerance: 0 }];
  }),
});

// Camera motion with the plane fixed in the world; the history is a flat 0.9 so only the
// current-frame weight is visible. The expectation follows the documented definition: the
// weight grows by parallaxBlend times the sine of the angle between the two view rays.
async function parallaxCase(context: CaseContext, parallaxBlend: number, move: (camera: THREE.Camera) => void) {
  return withRig(context, { parallaxBlend }, async rig => {
    settle(rig, 10, () => 0.9);
    const positionBefore = new THREE.Vector3().setFromMatrixPosition(rig.camera.matrixWorld);
    const previousWorld = rig.moveCamera(move);
    rig.setVelocity(rig.motionSince(previousWorld, () => D));
    rig.setAo(slight);
    rig.step(10);
    const out = await rig.read();
    const positionAfter = new THREE.Vector3().setFromMatrixPosition(rig.camera.matrixWorld);
    const expected = (i: number) => {
      const x = i % SIZE;
      const y = Math.floor(i / SIZE);
      const ndc = [((x + 0.5) * 2) / SIZE - 1, 1 - ((y + 0.5) * 2) / SIZE];
      const view = new THREE.Vector3((ndc[0] * D) / rig.camera.projectionMatrix.elements[0], (ndc[1] * D) / rig.camera.projectionMatrix.elements[5], -D);
      const point = view.applyMatrix4(rig.camera.matrixWorld);
      const rayBefore = point.clone().sub(positionBefore).normalize();
      const rayAfter = point.clone().sub(positionAfter).normalize();
      const alpha = Math.min(1, BASE_ALPHA + parallaxBlend * rayBefore.cross(rayAfter).length());
      return blendOld(slightAt(i), alpha);
    };
    return { out, expected, mean: (texels: Texels) => indices(4, 12, 4, 12).reduce((sum, i) => sum + texels.ao[i], 0) / 64 };
  });
}

const parallax: Case = {
  name: "parallax raises the current-frame weight under translation, not under rotation",
  run: async context => {
    const translate = (camera: THREE.Camera) => camera.translateX(0.2);
    const rotate = (camera: THREE.Camera) => camera.rotateY(THREE.MathUtils.degToRad(2));
    const [moved, turned, off] = [
      await parallaxCase(context, 20, translate), await parallaxCase(context, 20, rotate), await parallaxCase(context, 0, translate),
    ];
    const center = indices(4, 12, 4, 12);
    return [
      compare("translation, parallaxBlend 20: weight follows the view-ray angle", moved.out.ao, moved.expected, HALF, center),
      compare("rotation, parallaxBlend 20: no change of the weight", turned.out.ao, i => blendOld(slightAt(i)), HALF, center),
      compare("translation, parallaxBlend 0: no change of the weight", off.out.ao, i => blendOld(slightAt(i)), HALF, center),
      // The translation case must differ clearly from both controls, or the checks above prove nothing.
      { label: "translation raised the current-frame weight (mean output drop vs rotation)", error: Math.max(0, 0.1 - (turned.mean(turned.out) - moved.mean(moved.out))), tolerance: 0 },
    ];
  },
};

export const cases: Case[] = [
  firstFrame,
  ...cameras.map(([label, options]) => converge(`alternating input converges to the mean (${label}, blend 0.1)`, options, 0.1)),
  converge("alternating input converges to the mean (perspective, blend 0.3)", {}, 0.3),
  blendOne,
  ...cameras.slice(0, 2).map(([label, options]) => depthChange(`depth change (${label})`, options)),
  reset,
  shift("whole-texel velocity along x", "x"),
  shift("whole-texel velocity along y", "y"),
  dolly,
  clamp,
  ...[1, 0.75].flatMap(value => [value, 0.9].map(history => flatPassThrough(value, history))),
  parallax,
];
