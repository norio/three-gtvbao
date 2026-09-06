import { PerspectiveCamera, Quaternion, Vector3 } from "three/webgpu";
import type { GTVBAOSectorMeasure } from "../../src/GTVBAOSectorMeasure.js";

export interface CdfCase {
  normalAngle: number;
  horizons: [number, number];
}

export function createCdfCases(): CdfCase[] {
  const cases: CdfCase[] = [];
  const clampCos = (value: number) => Math.fround(Math.max(-1, Math.min(1, value)));
  for (const angle of [-Math.PI / 2, -1.3, -0.7, -0.2, 0, 0.35, 0.9, 1.4, Math.PI / 2]) {
    const normalAngle = Math.fround(angle);
    for (let i = 0; i <= 64; i++) {
      const h = clampCos(Math.cos(i * Math.PI / 64));
      cases.push({ normalAngle, horizons: [h, -h] });
    }
    // Exact tangent-plane boundaries, both sides of each boundary, and the pole.
    const edge = Math.sin(normalAngle);
    for (const h of [edge, -edge]) {
      cases.push({ normalAngle, horizons: [clampCos(h), clampCos(-h)] });
      cases.push({ normalAngle, horizons: [clampCos(h - 1e-5), clampCos(h + 1e-5)] });
    }
    cases.push({ normalAngle, horizons: [1, Math.fround(1 - 1e-6)] });
  }
  return cases;
}

// Independent definition: integrate the slice's hemisphere density, without
// the production closed form or its polynomial acos approximation.
export function referenceHorizonRemap(
  measure: GTVBAOSectorMeasure, normalAngle: number, horizonCos: number, right: boolean
) {
  const halfPi = Math.PI / 2;
  const psi = Math.max(-halfPi, Math.min(halfPi,
    -(right ? 1 : -1) * Math.acos(horizonCos) - normalAngle));
  if (measure === "angle") return (psi + halfPi) / Math.PI;
  const integrate = (from: number, to: number) => {
    const steps = 4000;
    const step = (to - from) / steps;
    let sum = 0;
    for (let i = 0; i < steps; i++) {
      const angle = from + (i + 0.5) * step;
      sum += Math.abs(Math.sin(angle + normalAngle)) * (measure === "cosine" ? Math.cos(angle) : 1);
    }
    return sum * step;
  };
  return integrate(-halfPi, psi) / integrate(-halfPi, halfPi);
}

export interface SliceCase {
  viewDir: Vector3;
  angle: number;
}

export function createSliceCases(): SliceCase[] {
  const cases: SliceCase[] = [];
  const add = (viewDir: Vector3, angle: number) => {
    viewDir.normalize();
    // Both CPU and GPU start from the same uploaded f32 inputs.
    viewDir.set(Math.fround(viewDir.x), Math.fround(viewDir.y), Math.fround(viewDir.z));
    cases.push({ viewDir, angle: Math.fround(angle) });
  };
  for (const direction of [[0, 0, 1], [0.3, -0.2, 0.9], [-0.7, 0.5, 0.4], [0.95, 0.3, 0.05]]) {
    for (let i = 0; i < 16; i++) add(new Vector3(...direction), i * Math.PI / 8);
  }
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 200; i++) {
    add(new Vector3((random() - 0.5) * 8, (random() - 0.5) * 8, 1 + random() * 30), random() * Math.PI);
  }
  return cases;
}

export function referenceSlice({ viewDir, angle }: SliceCase) {
  const v = viewDir.clone().normalize();
  const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), v);
  const tangent = new Vector3(1, 0, 0).applyQuaternion(rotation);
  const bitangent = new Vector3(0, 1, 0).applyQuaternion(rotation);
  const direction = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(bitangent, Math.sin(angle));
  const camera = new PerspectiveCamera(55, 2572 / 2656, 0.1, 120);
  const position = v.clone().multiplyScalar(-10);
  const toPixels = (point: Vector3) => {
    const ndc = point.applyMatrix4(camera.projectionMatrix);
    return new Vector3(ndc.x * 1286, ndc.y * 1328, 0);
  };
  // A finite difference of the real camera projection, not the shader's
  // perspective derivative. Symmetric samples reduce truncation error.
  const a = toPixels(position.clone().addScaledVector(direction, -1e-4));
  const b = toPixels(position.clone().addScaledVector(direction, 1e-4));
  return { tangent, bitangent, screenDirection: b.sub(a).normalize() };
}
