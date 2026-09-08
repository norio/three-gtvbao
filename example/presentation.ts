import type { Vector3 } from "three/webgpu";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { GUI } from "three/examples/jsm/libs/lil-gui.module.min.js";
import type { GTVBAONode } from "../src/index.js";
import type { ViewSettings } from "./main.js";
import {
  getCameraAspect, getCameraViewHeight, getFramedViewHeight,
  setOrthographicViewHeight, updateCameraProjection, type ExampleCamera,
} from "./camera.js";

const views = {
  overview: { position: [13.73674, 6.22224, 17.72657], target: [0, 1, -0.1] },
  arcade: { position: [2, 4.6, 10], target: [-2.15, 1.65, -2.3] },
  detail: { position: [7, 6.5, 9], target: [1.9, 0.9, 0.6] },
} satisfies Record<string, { position: [number, number, number]; target: [number, number, number] }>;
type CameraView = keyof typeof views;

function getCameraPosition(name: CameraView, aspect: number, position: Vector3) {
  const view = views[name];
  position.set(...view.position);
  if (name === "overview") {
    // Use the extra horizontal space, while keeping the whole study in frame.
    const t = Math.max(0, Math.min(1, (aspect - 1) / 0.6));
    const distanceScale = 1 - 0.25 * t * t * (3 - 2 * t);
    const [x, y, z] = view.target;
    position.set(
      x + (position.x - x) * distanceScale,
      y + (position.y - y) * distanceScale,
      z + (position.z - z) * distanceScale,
    );
  }
}

export function setCameraView(name: CameraView, camera: ExampleCamera, controls: OrbitControls) {
  const view = views[name];
  // Flush residual orbit damping before jumping to another composition.
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  controls.target.set(...view.target);
  getCameraPosition(name, getCameraAspect(camera), camera.position);
  updateCameraProjection(camera);
  if ("isOrthographicCamera" in camera) {
    setOrthographicViewHeight(camera, getFramedViewHeight(camera.position, controls.target, getCameraAspect(camera)));
  }
  controls.update();
  controls.enableDamping = damping;
}

export function updatePresentation(settings: ViewSettings, ao: GTVBAONode, backendName: string) {
  const debug = ao.debugMode.value !== 0;
  const view = settings.aoOnly || debug ? "ao" : settings.aoEnabled ? "beauty" : "off";
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  });
  const backend = document.querySelector("#render-backend");
  if (backend) {
    const quality = settings.preset === "Showcase" ? "SHOWCASE" : settings.preset.toUpperCase();
    backend.textContent = `${backendName} / ${quality}`;
  }
  const quality = document.querySelector("#render-quality");
  if (quality) quality.textContent = `${ao.sliceCount.value} SLICES · ${ao.stepCount.value} STEPS · ${Math.round(ao.resolutionScale * 100)}% AO`;
}

interface PresentationContext {
  camera: ExampleCamera;
  controls: OrbitControls;
  gui: GUI;
  settings: ViewSettings;
  aoNode: GTVBAONode;
  syncOutput(): void;
}

export function createPresentation({
  camera, controls, gui, settings, aoNode, syncOutput,
}: PresentationContext) {
  const fromPosition = camera.position.clone();
  const fromTarget = controls.target.clone();
  const toPosition = camera.position.clone();
  const toTarget = controls.target.clone();
  const transitionDuration = 1.1;
  let transitionElapsed = transitionDuration;
  let currentView: CameraView | null = "overview";
  let previousAspect = getCameraAspect(camera);
  let fromHeight = getCameraViewHeight(camera, controls.target);
  let toHeight = fromHeight;

  const transitionTo = (name: CameraView) => {
    fromPosition.copy(camera.position);
    fromTarget.copy(controls.target);
    fromHeight = getCameraViewHeight(camera, controls.target);
    // Clear orbit inertia without moving the visible starting pose.
    const damping = controls.enableDamping;
    const autoRotate = controls.autoRotate;
    controls.enableDamping = false;
    controls.autoRotate = false;
    controls.update();
    controls.enableDamping = damping;
    controls.autoRotate = autoRotate;
    camera.position.copy(fromPosition);
    controls.target.copy(fromTarget);
    camera.lookAt(controls.target);
    getCameraPosition(name, getCameraAspect(camera), toPosition);
    toTarget.set(...views[name].target);
    toHeight = getFramedViewHeight(toPosition, toTarget, getCameraAspect(camera));
    transitionElapsed = 0;
  };

  const projection = document.querySelector<HTMLSelectElement>("#projection");
  if (projection) {
    projection.value = "isOrthographicCamera" in camera ? "orthographic" : "perspective";
    projection.addEventListener("change", () => {
      const url = new URL(window.location.href);
      if (projection.value === "orthographic") url.searchParams.set("camera", "orthographic");
      else url.searchParams.delete("camera");
      window.location.assign(url.href);
    });
  }

  gui.domElement.id = "tuning-panel";
  gui.hide();
  const refreshGui = () => gui.controllersRecursive().forEach(controller => controller.updateDisplay());
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(button => {
    button.addEventListener("click", () => {
      settings.aoEnabled = button.dataset.view !== "off";
      settings.aoOnly = button.dataset.view === "ao";
      aoNode.debugMode.value = 0;
      syncOutput();
      refreshGui();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-camera]").forEach(button => {
    button.addEventListener("click", () => {
      currentView = button.dataset.camera as CameraView;
      transitionTo(currentView);
      document.querySelectorAll<HTMLButtonElement>("[data-camera]").forEach(other => {
        other.setAttribute("aria-pressed", String(other === button));
      });
    });
  });
  controls.addEventListener("start", () => {
    currentView = null;
    transitionElapsed = transitionDuration;
    document.querySelectorAll("[data-camera]").forEach(button => button.setAttribute("aria-pressed", "false"));
  });
  const rotate = document.querySelector<HTMLButtonElement>("#rotate");
  rotate?.addEventListener("click", () => {
    controls.autoRotate = !controls.autoRotate;
    rotate.setAttribute("aria-pressed", String(controls.autoRotate));
  });
  const lighting = document.querySelector<HTMLButtonElement>("#auto-lighting");
  lighting?.addEventListener("click", () => {
    settings.autoLighting = !settings.autoLighting;
    lighting.setAttribute("aria-pressed", String(settings.autoLighting));
  });
  const toggle = document.querySelector<HTMLButtonElement>("#settings-toggle");
  toggle?.addEventListener("click", () => {
    const show = toggle.getAttribute("aria-expanded") !== "true";
    gui.show(show);
    toggle.setAttribute("aria-expanded", String(show));
  });

  return (delta: number) => {
    if (Math.abs(getCameraAspect(camera) - previousAspect) > 1e-6) {
      previousAspect = getCameraAspect(camera);
      if (currentView !== null && (currentView === "overview" || transitionElapsed < transitionDuration)) {
        transitionTo(currentView);
      }
    }
    if (transitionElapsed >= transitionDuration) {
      controls.update(delta);
      return;
    }
    transitionElapsed = Math.min(transitionElapsed + delta, transitionDuration);
    const t = transitionElapsed / transitionDuration;
    const eased = t * t * (3 - 2 * t);
    camera.position.lerpVectors(fromPosition, toPosition, eased);
    controls.target.lerpVectors(fromTarget, toTarget, eased);
    camera.lookAt(controls.target);
    if ("isOrthographicCamera" in camera) {
      setOrthographicViewHeight(camera, fromHeight + (toHeight - fromHeight) * eased);
    }
  };
}
