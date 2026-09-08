import { OrthographicCamera, PerspectiveCamera, type Vector3 } from "three/webgpu";

export type ExampleCamera = PerspectiveCamera | OrthographicCamera;
export type CameraProjection = "perspective" | "orthographic";

const halfFieldOfView = 19 * Math.PI / 180;

export function createExampleCamera(projection: CameraProjection, aspect: number): ExampleCamera {
  const camera = projection === "orthographic"
    ? new OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    : new PerspectiveCamera(38, aspect, 0.1, 100);
  updateCameraProjection(camera, aspect);
  return camera;
}

export function getCameraAspect(camera: ExampleCamera): number {
  return camera instanceof PerspectiveCamera
    ? camera.aspect
    : (camera.right - camera.left) / (camera.top - camera.bottom);
}

export function updateCameraProjection(camera: ExampleCamera, aspect = getCameraAspect(camera)) {
  // Keep the shorter screen dimension's composition when crossing portrait.
  if (camera instanceof PerspectiveCamera) {
    camera.aspect = aspect;
    camera.fov = 2 * Math.atan(Math.tan(halfFieldOfView) / Math.min(1, aspect)) * 180 / Math.PI;
  } else {
    const shortSide = Math.min(camera.right - camera.left, camera.top - camera.bottom);
    const halfHeight = shortSide / Math.min(1, aspect) / 2;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
  }
  camera.updateProjectionMatrix();
}

export function getCameraViewHeight(camera: ExampleCamera, target: Vector3): number {
  return camera instanceof PerspectiveCamera
    ? camera.position.distanceTo(target) * 2 * Math.tan(camera.fov * Math.PI / 360) / camera.zoom
    : (camera.top - camera.bottom) / camera.zoom;
}

export function getFramedViewHeight(position: Vector3, target: Vector3, aspect: number): number {
  return position.distanceTo(target) * 2 * Math.tan(halfFieldOfView) / Math.min(1, aspect);
}

export function setOrthographicViewHeight(camera: OrthographicCamera, height: number) {
  const aspect = getCameraAspect(camera);
  camera.left = -height * aspect / 2;
  camera.right = height * aspect / 2;
  camera.top = height / 2;
  camera.bottom = -height / 2;
  camera.zoom = 1;
  camera.updateProjectionMatrix();
}
