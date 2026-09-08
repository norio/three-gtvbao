import assert from "node:assert/strict";
import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three/webgpu";
import { test } from "vitest";
import {
  createExampleCamera, getCameraAspect, getCameraViewHeight,
  getFramedViewHeight, setOrthographicViewHeight, updateCameraProjection,
} from "../example/camera.js";

const closeTo = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

for (const aspect of [16 / 9, 1, 9 / 16]) {
  test(`projection switch preserves target-plane framing at aspect ${aspect}`, () => {
    const perspective = createExampleCamera("perspective", aspect);
    const orthographic = createExampleCamera("orthographic", aspect);
    assert.ok(perspective instanceof PerspectiveCamera);
    assert.ok(orthographic instanceof OrthographicCamera);
    const target = new Vector3(0, 0, 0);
    perspective.position.set(0, 0, 10);
    perspective.zoom = 1.7;
    perspective.updateProjectionMatrix();
    perspective.updateMatrixWorld();
    orthographic.position.copy(perspective.position);
    setOrthographicViewHeight(orthographic, getCameraViewHeight(perspective, target));
    orthographic.updateMatrixWorld();
    // Independent matrix projections must agree for points on the orbit plane.
    for (const point of [new Vector3(1, 1, 0), new Vector3(-2, -1, 0)]) {
      const a = point.clone().project(perspective);
      const b = point.clone().project(orthographic);
      closeTo(a.x, b.x);
      closeTo(a.y, b.y);
    }
    closeTo(getCameraAspect(orthographic), aspect);
    closeTo(getCameraViewHeight(orthographic, target), getCameraViewHeight(perspective, target));
    closeTo(getFramedViewHeight(perspective.position, target, aspect), getCameraViewHeight(perspective, target) * perspective.zoom);
    assert.equal(orthographic.near, perspective.near);
    assert.equal(orthographic.far, perspective.far);
  });
}

test("orthographic resize preserves zoom and short-side framing through portrait and back", () => {
  const camera = createExampleCamera("orthographic", 2);
  assert.ok(camera instanceof OrthographicCamera);
  setOrthographicViewHeight(camera, 8);
  camera.zoom = 2;
  camera.updateProjectionMatrix();
  updateCameraProjection(camera, 0.5);
  assert.equal(camera.zoom, 2);
  closeTo(getCameraAspect(camera), 0.5);
  closeTo(new Vector3(2, 0, -10).project(camera).x, 1);
  closeTo(new Vector3(0, 4, -10).project(camera).y, 1);
  updateCameraProjection(camera, 2);
  closeTo(getCameraViewHeight(camera, new Vector3()), 4);
  closeTo(new Vector3(4, 0, -10).project(camera).x, 1);
  closeTo(new Vector3(0, 2, -10).project(camera).y, 1);
});

test("orthographic framing resets orbit zoom while preserving aspect", () => {
  const camera = new OrthographicCamera(-6, 6, 3, -3, 0.1, 100);
  camera.zoom = 3;
  setOrthographicViewHeight(camera, 10);
  assert.equal(camera.zoom, 1);
  closeTo(getCameraAspect(camera), 2);
  closeTo(new Vector3(10, 5, -10).project(camera).x, 1);
  closeTo(new Vector3(10, 5, -10).project(camera).y, 1);
});

test("perspective resize preserves the existing portrait composition", () => {
  const camera = createExampleCamera("perspective", 2);
  assert.ok(camera instanceof PerspectiveCamera);
  camera.position.z = 10;
  camera.updateMatrixWorld();
  const halfShortSide = 10 * Math.tan(19 * Math.PI / 180);
  closeTo(new Vector3(0, halfShortSide, 0).project(camera).y, 1);
  updateCameraProjection(camera, 0.5);
  closeTo(new Vector3(halfShortSide, 0, 0).project(camera).x, 1);
  updateCameraProjection(camera, 2);
  closeTo(camera.fov, 38);
});
