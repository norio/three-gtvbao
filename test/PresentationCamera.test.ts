import { Vector3 } from "three/webgpu";
import { afterEach, expect, test, vi } from "vitest";
import { createExampleCamera, updateCameraProjection } from "../example/camera.js";
import { createPresentation, setCameraView } from "../example/presentation.js";

afterEach(() => vi.unstubAllGlobals());

test.each([
  { view: "arcade", fromAspect: 2, toAspect: 0.5 },
  { view: "detail", fromAspect: 2, toAspect: 0.5 },
  { view: "arcade", fromAspect: 0.5, toAspect: 2 },
  { view: "detail", fromAspect: 0.5, toAspect: 2 },
] as const)("$view transition preserves framing after resize $fromAspect → $toAspect", ({ view, fromAspect, toAspect }) => {
  let click = () => {};
  const button = {
    dataset: { camera: view },
    addEventListener(_event: string, listener: () => void) { click = listener; },
    setAttribute() {},
  };
  vi.stubGlobal("document", {
    querySelector() { return null; },
    querySelectorAll(selector: string) { return selector === "[data-camera]" ? [button] : []; },
  });

  type Context = Parameters<typeof createPresentation>[0];
  const controls = {
    target: new Vector3(),
    enableDamping: true,
    autoRotate: false,
    update() {},
    addEventListener() {},
  } as unknown as Context["controls"];
  const camera = createExampleCamera("orthographic", fromAspect);
  setCameraView("overview", camera, controls);
  const update = createPresentation({
    camera,
    controls,
    gui: { domElement: {}, hide() {} } as unknown as Context["gui"],
    settings: {} as Context["settings"],
    aoNode: {} as Context["aoNode"],
    syncOutput() {},
  });

  click();
  update(0.3);
  updateCameraProjection(camera, toAspect);
  update(1.1);

  // A resized animation must finish at the same composition as selecting the
  // preset directly at that viewport size, including its projection matrix.
  const expectedCamera = createExampleCamera("orthographic", toAspect);
  const finalTarget = controls.target.clone();
  setCameraView(view, expectedCamera, controls);
  expect(camera.position.toArray()).toEqual(expectedCamera.position.toArray());
  expect(finalTarget.toArray()).toEqual(controls.target.toArray());
  for (let i = 0; i < 16; i++) {
    expect(camera.projectionMatrix.elements[i]).toBeCloseTo(expectedCamera.projectionMatrix.elements[i], 12);
  }
});
