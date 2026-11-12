import * as THREE from "three/webgpu";
import { assertBackend, forceWebGL, reportProgress, requestedBackend } from "./backend.js";
import { cases, type Check } from "./temporal-cases.js";

type Row = Check & { passed: boolean };

const row = (check: Check): Row => ({ ...check, passed: check.error <= check.tolerance });

async function run() {
  const rows: Row[] = [];
  for (const logarithmicDepthBuffer of [false, true]) {
    const renderer = new THREE.WebGPURenderer({ logarithmicDepthBuffer, antialias: false, forceWebGL });
    renderer.setPixelRatio(1);
    renderer.setSize(16, 16);
    reportProgress(`Renderer: initializing (${logarithmicDepthBuffer ? "log" : "normal"} depth)`);
    await renderer.init();
    try {
      assertBackend(renderer);
      for (const testCase of cases) {
        const prefix = `${logarithmicDepthBuffer ? "log" : "normal"} / ${testCase.name}`;
        reportProgress(prefix);
        try {
          for (const check of await testCase.run({ renderer })) rows.push(row({ ...check, label: `${prefix}: ${check.label}` }));
        } catch (error) {
          rows.push({ label: `${prefix}: threw ${String(error)}`, error: Infinity, tolerance: 0, passed: false });
        }
      }
    } finally {
      renderer.dispose();
    }
  }
  return { backend: requestedBackend, passed: rows.every(entry => entry.passed), rows };
}

// Machine-readable completion for browser automation; an unavailable backend is a failure.
const result = await run().catch(error => ({ passed: false, error: String(error) }));
Object.assign(window, { temporalRegression: result });
document.querySelector("#status")!.textContent = "rows" in result
  ? `${result.passed ? "PASS" : "FAIL"} — ${result.backend}\n` + result.rows.map(entry =>
    `${entry.passed ? "PASS" : "FAIL"}  ${entry.label}: error ${entry.error.toExponential(2)} (tolerance ${entry.tolerance.toExponential(2)})`).join("\n")
  : result.error;
