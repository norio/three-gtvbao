import * as THREE from "three/webgpu";
import { int, ivec2, screenCoordinate, texture } from "three/tsl";
import { GTVBAO_SECTOR_MEASURE_OPTIONS } from "../../src/GTVBAOSectorMeasure.js";
import { createCdfProbe, createSliceProbe } from "./math-nodes.js";
import { createCdfCases, createSliceCases, referenceHorizonRemap, referenceSlice } from "./math-reference.js";

import { assertBackend, forceWebGL, renderProbe, reportProgress } from "./backend.js";
import { checkViewPositions } from "./view-space.js";

interface Comparison {
  actual: number;
  expected: number;
  label: string;
}

function summarize(label: string, comparisons: Comparison[], tolerance: number) {
  let maxError = 0;
  let squaredError = 0;
  let worstCase = "";
  let failures = 0;
  for (const entry of comparisons) {
    const error = Math.abs(entry.actual - entry.expected);
    if (!Number.isFinite(error)) throw new Error(`Nonfinite value: ${label} / ${entry.label}`);
    squaredError += error * error;
    if (error > maxError) {
      maxError = error;
      worstCase = entry.label;
    }
    if (error > tolerance) failures++;
  }
  return {
    label, cases: comparisons.length, maxError,
    rmse: Math.sqrt(squaredError / comparisons.length),
    tolerance, failures, worstCase, passed: failures === 0,
  };
}

function makeTexture(values: number[]) {
  const result = new THREE.DataTexture(new Float32Array(values), values.length / 4, 1, THREE.RGBAFormat, THREE.FloatType);
  result.needsUpdate = true;
  return result;
}

async function checkCdf(renderer: THREE.WebGPURenderer) {
  const cases = createCdfCases();
  const input = makeTexture(cases.flatMap(entry => [entry.normalAngle, ...entry.horizons, 0]));
  const fixture = texture(input).load(ivec2(int(screenCoordinate.x), 0));
  const results = [];
  try {
    for (const measure of Object.values(GTVBAO_SECTOR_MEASURE_OPTIONS)) {
      const pixels = await renderProbe(renderer, createCdfProbe(measure, fixture), cases.length);
      const comparisons = cases.flatMap((entry, index) =>
        [true, false].flatMap((right, direction) => entry.horizons.map((h, edge) => ({
          actual: pixels[index * 4 + direction * 2 + edge],
          expected: referenceHorizonRemap(measure, entry.normalAngle, h, right),
          label: `n=${entry.normalAngle}, h=${h}, right=${right}, edge=${edge}`,
        })))
      );
      // The angle/cosine paths deliberately use the production approximate
      // acos; solid angle has no approximation beyond f32 and quadrature.
      const tolerance = measure === "cosine" ? 4e-3 : measure === "angle" ? 3e-3 : 2e-5;
      results.push(summarize(`horizon / ${measure}`, comparisons, tolerance));
    }
    return { inputCases: cases.length, results };
  } finally {
    input.dispose();
  }
}

async function checkSlices(renderer: THREE.WebGPURenderer) {
  const cases = createSliceCases();
  const input = makeTexture(cases.flatMap(entry => [...entry.viewDir.toArray(), entry.angle]));
  const fixture = texture(input).load(ivec2(int(screenCoordinate.x), 0));
  try {
    // One draw stores tangent, bitangent and screen direction in separate rows.
    const pixels = await renderProbe(renderer, createSliceProbe(fixture, screenCoordinate.y), cases.length, 3);
    const tangent: Comparison[] = [];
    const bitangent: Comparison[] = [];
    const projection: Comparison[] = [];
    const orthonormal: Comparison[] = [];
    for (const [index, entry] of cases.entries()) {
      const expected = referenceSlice(entry);
      const vectors = [0, 1, 2].map(row => new THREE.Vector3().fromArray(pixels, (row * cases.length + index) * 4));
      const targets = [expected.tangent, expected.bitangent, expected.screenDirection];
      for (const [row, comparisons] of [tangent, bitangent, projection].entries()) {
        for (const component of ["x", "y", "z"] as const) {
          comparisons.push({ actual: vectors[row][component], expected: targets[row][component], label: `sample ${index} / ${component}` });
        }
      }
      const [t, b] = vectors;
      const v = entry.viewDir.clone().normalize();
      const errors = [
        t.length() - 1, b.length() - 1, t.dot(b), t.dot(v), b.dot(v),
        new THREE.Vector3().crossVectors(t, b).distanceTo(v),
      ];
      errors.forEach((actual, invariant) => orthonormal.push({ actual, expected: 0, label: `sample ${index} / invariant ${invariant}` }));
    }
    return {
      inputCases: cases.length,
      results: [
        summarize("slice / tangent vs quaternion", tangent, 2e-5),
        summarize("slice / bitangent vs quaternion", bitangent, 2e-5),
        summarize("slice / perspective projection", projection, 2e-5),
        summarize("slice / orthonormal and right-handed", orthonormal, 2e-5),
      ],
    };
  } finally {
    input.dispose();
  }
}

async function run() {
  const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL });
  renderer.setPixelRatio(1);
  renderer.setSize(1, 1);
  try {
    reportProgress("Renderer: initializing");
    await renderer.init();
    reportProgress("Renderer: initialized");
    const backend = assertBackend(renderer);
    reportProgress("CDF: starting");
    const cdf = await checkCdf(renderer);
    reportProgress("Slices: starting");
    const slices = await checkSlices(renderer);
    reportProgress("View positions: starting");
    const viewPositions = await checkViewPositions(renderer);
    const results = [...cdf.results, ...slices.results, ...viewPositions];
    return {
      backend, passed: results.every(entry => entry.passed), drawCalls: 4 + viewPositions.length,
      inputCases: { cdf: cdf.inputCases, slices: slices.inputCases },
      caseCount: results.reduce((sum, entry) => sum + entry.cases, 0), results,
    };
  } finally {
    renderer.dispose();
  }
}

const result = await run().catch(error => ({ passed: false, error: String(error) }));
Object.assign(window, { mathRegression: result });
document.querySelector("#status")!.textContent = JSON.stringify(result, null, 2);
