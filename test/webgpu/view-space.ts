import * as THREE from "three/webgpu";
import { Fn, getViewPosition, int, ivec2, length, screenCoordinate, texture, uniform, vec2, vec4 } from "three/tsl";
import {
  createPerspectiveTexelViewPosition, createPerspectiveViewPositionFromLinearDepth, getPerspectiveViewPosition,
} from "../../src/GTVBAOViewSpace.js";
import { renderProbe } from "./backend.js";

const WIDTH = 127;
const HEIGHT = 83;
const TOLERANCE = 2e-4;

export async function checkViewPositions(renderer: THREE.WebGPURenderer) {
  const results = [];
  for (const offset of [false, true]) {
    const camera = new THREE.PerspectiveCamera(67, WIDTH / HEIGHT, 0.1, 300);
    camera.coordinateSystem = renderer.coordinateSystem;
    if (offset) camera.setViewOffset(WIDTH * 2, HEIGHT * 2, 17, 23, WIDTH, HEIGHT);
    camera.updateProjectionMatrix();
    const fixtures = [];
    for (const y of [0, 13, 41, 82]) {
      for (const x of [0, 31, 63, 95, 126]) {
        for (const distance of [0.11, 0.3, 1, 10, 100]) {
          const u = (x + 0.5) / WIDTH;
          const v = (y + 0.5) / HEIGHT;
          const clipZ = new THREE.Vector3(0, 0, -distance).applyMatrix4(camera.projectionMatrix).z;
          const depth = camera.coordinateSystem === THREE.WebGPUCoordinateSystem ? clipZ : clipZ * 0.5 + 0.5;
          // A CPU matrix inverse is independent of the specialized production
          // reconstruction and exercises nonzero view-offset projection terms.
          const position = new THREE.Vector3(u * 2 - 1, 1 - v * 2, clipZ).applyMatrix4(camera.projectionMatrixInverse);
          fixtures.push({ u, v, depth, distance, position });
        }
      }
    }
    const input = new THREE.DataTexture(new Float32Array(fixtures.flatMap(f => [f.u, f.v, f.depth, f.distance])),
      fixtures.length, 1, THREE.RGBAFormat, THREE.FloatType);
    input.needsUpdate = true;
    try {
      for (const mode of ["uv-depth", "texel-depth", "linear-depth"] as const) {
        const probe = Fn(() => {
          const fixture = texture(input).load(ivec2(int(screenCoordinate.x), 0)).toConst();
          const inverse = uniform(camera.projectionMatrixInverse);
          const reference = getViewPosition(fixture.xy, fixture.z, inverse).toConst();
          const actual = (mode === "uv-depth"
            ? getPerspectiveViewPosition(fixture.xy, fixture.z, inverse)
            : mode === "texel-depth"
              ? createPerspectiveTexelViewPosition(inverse, vec2(1 / WIDTH, 1 / HEIGHT))(
                fixture.xy.mul(vec2(WIDTH, HEIGHT)).sub(0.5), fixture.z)
              : createPerspectiveViewPositionFromLinearDepth(inverse)(fixture.xy, fixture.w)).toConst();
          return vec4(actual, length(actual.sub(reference)));
        })();
        const pixels = await renderProbe(renderer, probe, fixtures.length);
        let maxError = 0;
        let squaredError = 0;
        let failures = 0;
        let worstCase = "";
        fixtures.forEach((fixture, index) => {
          const actual = new THREE.Vector3().fromArray(pixels, index * 4);
          // Relative error keeps near-plane and far-plane probes comparable.
          const scale = Math.max(1, fixture.position.length());
          const errors = [actual.distanceTo(fixture.position) / scale, pixels[index * 4 + 3] / scale];
          errors.forEach((error, reference) => {
            if (!Number.isFinite(error)) throw new Error(`Nonfinite view position: ${mode}`);
            squaredError += error * error;
            if (error > maxError) {
              maxError = error;
              worstCase = `fixture ${index} / ${reference === 0 ? "CPU matrix" : "three getViewPosition"}`;
            }
            if (error > TOLERANCE) failures++;
          });
        });
        const cases = fixtures.length * 2;
        results.push({ label: `view position / ${offset ? "view-offset" : "centered"} / ${mode}`,
          cases, maxError, rmse: Math.sqrt(squaredError / cases), tolerance: TOLERANCE,
          failures, worstCase, passed: failures === 0 });
      }
    } finally {
      input.dispose();
    }
  }
  return results;
}
