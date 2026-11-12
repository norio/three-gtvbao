import * as THREE from "three/webgpu";
import { texture } from "three/tsl";
import { applyGtvbaoPreset, GTVBAO_PRESETS, type GTVBAOPresetName } from "../../src/index.js";
import * as example from "../../example/main.js";
import { updateCameraProjection } from "../../example/camera.js";
import { setCameraView } from "../../example/presentation.js";
import { assertBackend, readFloatTarget, reportProgress } from "./backend.js";
import { accumulate, boxFilter, createAccumulator, summarize } from "./flicker-stats.js";

const { renderer, scene, camera, controls, aoNode, denoiseNode, pipeline, settings, syncOutput } = example;
type NodeOptions = Record<string, unknown>;
type Variant = {
  label: string;
  ao?: NodeOptions;
  denoiser?: NodeOptions;
  settings?: NodeOptions;
  targets?: Record<string, NodeOptions>;
};

renderer.setAnimationLoop(null);
document.querySelector(".lil-gui.root")?.remove();
let target: THREE.RenderTarget | undefined;
let noiseTexture: THREE.DataTexture | undefined;

function readNumber(value: string, name: string, minimum: number, integer = false) {
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number) || number < minimum ||
    (integer && !Number.isSafeInteger(number))) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return number;
}

function readToggle(value: string, name: string) {
  if (value !== "0" && value !== "1") throw new Error(`Invalid ${name}: ${value}`);
  return value === "1";
}

function readJson(value: string, name: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${name} JSON: ${String(error)}`);
  }
  return parsed;
}

function readObject(value: unknown, name: string): NodeOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${name}: expected a JSON object`);
  }
  return value as NodeOptions;
}

function readVariants(value: string): Variant[] {
  const parsed = readJson(value, "variants");
  if (!Array.isArray(parsed)) throw new Error("Invalid variants: expected a JSON array");
  return parsed.map((entry: unknown, index) => {
    const name = `variants[${index}]`;
    const variant = readObject(entry, name);
    if (typeof variant.label !== "string") throw new Error(`Invalid ${name}.label: expected a string`);
    for (const key of ["ao", "denoiser", "settings"]) {
      if (key in variant) readObject(variant[key], `${name}.${key}`);
    }
    if ("targets" in variant) {
      const targets = readObject(variant.targets, `${name}.targets`);
      for (const [key, options] of Object.entries(targets)) readObject(options, `${name}.targets.${key}`);
    }
    return variant as Variant;
  });
}

function exportedTarget(name: string): object {
  const exports = example as Record<string, unknown>;
  const node = exports[name];
  if (!Object.hasOwn(exports, name) || node === null || typeof node !== "object") {
    throw new Error(`Missing or non-object example export for targets: ${name}`);
  }
  return node;
}

function createOptionRestorer() {
  const originals = new Map<object, Map<string, () => void>>();
  return {
    remember(node: object, options: NodeOptions = {}) {
      let keys = originals.get(node);
      if (keys === undefined) originals.set(node, keys = new Map());
      const properties = node as NodeOptions;
      for (const key of Object.keys(options)) {
        if (keys.has(key)) continue;
        const exists = key in node;
        const current = properties[key];
        if (current !== null && typeof current === "object" && "value" in current) {
          const value = current.value;
          keys.set(key, () => { current.value = value; });
        } else keys.set(key, () => { if (exists) properties[key] = current; else delete properties[key]; });
      }
    },
    restore() {
      for (const keys of originals.values()) for (const reset of keys.values()) reset();
    },
  };
}

function applyNodeOptions(node: object, options: NodeOptions, name: string) {
  const properties = node as NodeOptions;
  for (const [key, value] of Object.entries(options)) {
    if (!(key in node)) throw new Error(`Unknown ${name} option: ${key}`);
    const current = properties[key];
    if (current !== null && typeof current === "object" && "value" in current) current.value = value;
    else properties[key] = value;
  }
}

function readOptions() {
  const params = new URLSearchParams(location.search);
  const size = params.get("size") ?? "960x540";
  const dimensions = /^(\d+)x(\d+)$/.exec(size);
  if (dimensions === null) throw new Error(`Invalid size: ${size}`);
  const width = readNumber(dimensions[1], "width", 1, true);
  const height = readNumber(dimensions[2], "height", 1, true);
  const view = params.get("view") ?? "detail";
  if (view !== "overview" && view !== "detail") throw new Error(`Invalid view: ${view}`);
  const preset = params.get("preset") ?? "Balanced";
  if (!Object.hasOwn(GTVBAO_PRESETS, preset)) throw new Error(`Unknown GTVBAO preset: ${preset}`);
  const scales = (params.get("scales") ?? "1,0.75,0.5,0.25").split(",").map(value => {
    const scale = readNumber(value, "scale", 0);
    if (scale === 0) throw new Error("Scale must be positive");
    return scale;
  });
  const denoise = (params.get("denoise") ?? "0").split(",").map(value => readToggle(value.trim(), "denoise"));
  const blurs = (params.get("blurs") ?? "1,4,8").split(",").map(value => readNumber(value, "blur", 1, true));
  const ao = readObject(readJson(params.get("ao") ?? "{}", "ao"), "ao");
  const denoiser = readObject(readJson(params.get("denoiser") ?? "{}", "denoiser"), "denoiser");
  const ref = params.has("ref") ? readObject(readJson(params.get("ref")!, "ref"), "ref") : null;
  const frames = readNumber(params.get("frames") ?? "48", "frames", 1, true);
  if (ref !== null && frames > 96) throw new Error("frames must not exceed 96 when ref is present");
  const variants: Variant[] = params.has("variants")
    ? readVariants(params.get("variants")!) : [{ label: "", ao, denoiser }];
  return {
    width, height, view: view as "overview" | "detail",
    preset: preset as GTVBAOPresetName, scales, denoise, blurs,
    ao, denoiser, ref, frames, variants,
    orbit: readNumber(params.get("orbit") ?? "0", "orbit", -Infinity),
    only: readToggle(params.get("only") ?? "1", "only"),
    warmup: readNumber(params.get("warmup") ?? "48", "warmup", 0, true),
    gain: readNumber(params.get("gain") ?? "20", "gain", 0),
  };
}

type Options = ReturnType<typeof readOptions>;
type BandResult = {
  blur: number;
  stdMean: number;
  stdP95: number;
  stdMax: number;
  frameDelta: number;
};
type CaseResult = {
  name: string;
  scale: number | null;
  denoise: boolean;
  meanLuma: number;
  temporalStd: { mean: number; p50: number; p95: number; p99: number; max: number };
  frameDelta: number;
  biasVsFull: number | null;
  bands: BandResult[];
  motion: { blur: number; error: number }[] | null;
};

function renderFrames(
  name: string, { warmup, frames, orbit, view }: Options, output: THREE.RenderTarget,
  accumulate: (pixels: Float32Array, frame: number) => void,
) {
  if (orbit !== 0) {
    setCameraView(view, camera, controls);
    controls.update();
  }
  const axis = new THREE.Vector3(0, 1, 0);
  const angle = THREE.MathUtils.degToRad(orbit);
  reportProgress(`${name}: waiting for frame 1/${warmup + frames}`);
  // Only the renderer's animation loop advances the NodeFrame FRAME guard.
  return new Promise<void>((resolve, reject) => {
    let rendered = 0;
    const draw = async () => {
      try {
        reportProgress(rendered < warmup
          ? `${name}: warmup ${rendered + 1}/${warmup}`
          : `${name}: measuring ${rendered - warmup + 1}/${frames}`);
        renderer.setRenderTarget(output);
        if (orbit !== 0) {
          camera.position.sub(controls.target).applyAxisAngle(axis, angle).add(controls.target);
          camera.lookAt(controls.target);
          camera.updateMatrixWorld();
        }
        pipeline.render();
        rendered++;
        if (rendered <= warmup) return;
        // Keep the target unchanged until this frame's asynchronous copy completes.
        renderer.setAnimationLoop(null);
        const pixels = await readFloatTarget(renderer, output);
        if (!pixels.every(Number.isFinite)) {
          throw new Error(`Nonfinite output in ${name}, measured frame ${rendered - warmup}`);
        }
        accumulate(pixels, rendered - warmup);
        if (rendered === warmup + frames) resolve();
        else renderer.setAnimationLoop(draw);
      } catch (error) {
        renderer.setAnimationLoop(null);
        reject(error);
      }
    };
    renderer.setAnimationLoop(draw);
  });
}

function showImages(
  name: string, mean: Float64Array, std: Float64Array, blurredStd: Float64Array,
  blur: number, { width, height, gain }: Options,
) {
  const section = document.createElement("section");
  const title = document.createElement("h2");
  title.textContent = name;
  section.append(title);
  for (const [label, values, multiplier] of [
    ["Temporal-mean luma", mean, 1],
    [`Temporal standard deviation × ${gain}`, std, gain],
    [`Temporal standard deviation, blur ${blur} × ${gain * 4}`, blurredStd, gain * 4],
  ] as const) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.title = label;
    canvas.setAttribute("aria-label", label);
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(width, height);
    for (let i = 0; i < values.length; i++) {
      const gray = Math.round(Math.max(0, Math.min(1, values[i] * multiplier)) * 255);
      image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = gray;
      image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    section.append(canvas);
  }
  document.querySelector("#images")!.append(section);
}

async function measureCase(
  name: string, scale: number | null, denoise: boolean, options: Options, output: THREE.RenderTarget,
  reference: Float32Array[] | null = null, captureReference = false,
) {
  const { width, height, blurs } = options;
  const count = width * height;
  const accumulators = [...new Set([1, ...blurs])].map(blur => createAccumulator(blur, count));
  const luma = new Float64Array(count);
  const scratch = new Float64Array(count);
  const filtered = new Float64Array(count);
  const difference = reference !== null && !captureReference ? new Float64Array(count) : null;
  const motion = reference === null ? null : blurs.map(blur => ({ blur, error: 0 }));
  await renderFrames(name, options, output, (pixels, frame) => {
    for (let i = 0; i < count; i++) {
      const offset = i * 4;
      luma[i] = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
    }
    for (const accumulator of accumulators) {
      if (accumulator.blur === 1) accumulate(accumulator, luma, frame);
      else {
        boxFilter(luma, scratch, filtered, width, height, accumulator.blur);
        accumulate(accumulator, filtered, frame);
      }
    }
    if (captureReference) reference!.push(Float32Array.from(luma));
    else if (difference !== null) {
      for (let i = 0; i < count; i++) difference[i] = luma[i] - reference![frame - 1][i];
      for (const band of motion!) {
        boxFilter(difference, scratch, filtered, width, height, band.blur);
        for (const value of filtered) band.error += Math.abs(value);
      }
    }
  });
  for (const band of motion ?? []) band.error /= options.frames * count;
  const summaries = accumulators.map(accumulator => summarize(accumulator, options.frames));
  const unfiltered = summaries[0];
  const largest = summaries.reduce((a, b) => a.blur > b.blur ? a : b);
  const result: CaseResult = {
    name, scale, denoise, meanLuma: unfiltered.meanLuma,
    temporalStd: unfiltered.temporalStd, frameDelta: unfiltered.frameDelta, biasVsFull: null,
    motion,
    bands: blurs.map(blur => {
      const { temporalStd, frameDelta } = summaries.find(entry => entry.blur === blur)!;
      return { blur, stdMean: temporalStd.mean, stdP95: temporalStd.p95, stdMax: temporalStd.max, frameDelta };
    }),
  };
  showImages(name, unfiltered.mean, unfiltered.std, largest.std, largest.blur, options);
  return { result, mean: unfiltered.mean };
}

function formatTable(cases: CaseResult[], blurs: number[], hasReference: boolean) {
  const number = (value: number | null) => value === null ? "null" : value.toExponential(2);
  const rows = [
    ["case", "scale", "denoise", "meanLuma",
      ...blurs.flatMap(blur => [`std@${blur} mean`, `std@${blur} p95`, `delta@${blur}`]), "biasVsFull",
      ...(hasReference ? blurs.map(blur => `err@${blur}`) : [])],
    ...cases.map(entry => [
      entry.name, String(entry.scale), String(Number(entry.denoise)), number(entry.meanLuma),
      ...entry.bands.flatMap(band => [number(band.stdMean), number(band.stdP95), number(band.frameDelta)]),
      number(entry.biasVsFull),
      ...(hasReference ? blurs.map((_, index) => number(entry.motion?.[index].error ?? null)) : []),
    ]),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  return {
    text: rows.map(row => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n"),
    tsv: rows.map(row => row.join("\t")).join("\n"),
  };
}

async function run() {
  const options = readOptions();
  const { width, height, view, preset, only, warmup, frames, blurs, ao, denoiser, variants, orbit, ref } = options;
  const initialSettings = { ...settings };
  const originals = createOptionRestorer();
  originals.remember(aoNode, ref ?? {});
  // Capture the union before presets, overrides or rendering can change any key.
  for (const variant of variants) {
    originals.remember(aoNode, variant.ao);
    originals.remember(denoiseNode, variant.denoiser);
    originals.remember(settings, variant.settings);
    for (const [name, options] of Object.entries(variant.targets ?? {})) {
      originals.remember(exportedTarget(name), options);
    }
  }
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  updateCameraProjection(camera, width / height);
  setCameraView(view, camera, controls);
  controls.enableDamping = false;
  controls.update();
  scene.getObjectByName("Rotating ceramic")!.rotation.y = 0;
  pipeline.outputColorTransform = false;
  pipeline.needsUpdate = true;
  const output = new THREE.RenderTarget(width, height, { type: THREE.FloatType, depthBuffer: false });
  target = output;
  // Match example.ts instead of the denoiser's default Math.random() noise.
  noiseTexture = new THREE.DataTexture(
    Uint8Array.from({ length: 64 * 64 * 4 }, (_, i) => (i * 73 + (i >> 8) * 37) % 256), 64, 64,
  );
  noiseTexture.wrapS = noiseTexture.wrapT = THREE.RepeatWrapping;
  noiseTexture.needsUpdate = true;
  denoiseNode.noiseNode = texture(noiseTexture);

  const backend = assertBackend(renderer);
  const cases: CaseResult[] = [];
  // The baseline is pinned because the example's defaults enable accumulation and jitter.
  settings.preset = preset;
  if (!only) {
    originals.restore();
    Object.assign(settings, { aoEnabled: false, aoOnly: false, denoise: false, accumulate: false, traa: true, temporal: true });
    syncOutput();
    const { result } = await measureCase("ao-off", null, false, options, output);
    cases.push(result);
  }
  const reference: Float32Array[] | null = ref === null ? null : [];
  if (ref !== null) {
    originals.restore();
    applyGtvbaoPreset(aoNode, { ...GTVBAO_PRESETS[preset], resolutionScale: 1 }, denoiseNode);
    aoNode.upsampleJitter = 0;
    applyNodeOptions(aoNode, ref, "ref aoNode");
    Object.assign(settings, initialSettings, { aoEnabled: true, aoOnly: only, denoise: false, accumulate: false, traa: true, temporal: true });
    syncOutput();
    const { result } = await measureCase("reference", 1, false, options, output, reference, true);
    cases.push(result);
  }
  settings.preset = preset;
  for (const variant of variants) {
    for (const denoise of options.denoise) {
      const measurements = [];
      for (const scale of options.scales) {
        originals.restore();
        applyGtvbaoPreset(aoNode, { ...GTVBAO_PRESETS[preset], resolutionScale: scale }, denoiseNode);
        aoNode.upsampleJitter = 0;
        applyNodeOptions(aoNode, variant.ao ?? {}, "aoNode");
        applyNodeOptions(denoiseNode, variant.denoiser ?? {}, "denoiseNode");
        Object.assign(settings, { aoEnabled: true, aoOnly: only, denoise, accumulate: false, traa: true, temporal: true });
        Object.assign(settings, variant.settings ?? {});
        for (const [exportName, options] of Object.entries(variant.targets ?? {})) {
          applyNodeOptions(exportedTarget(exportName), options, exportName);
        }
        const name = `${variant.label ? `${variant.label}:` : ""}${denoise ? "denoised" : "raw"}-${scale}`;
        reportProgress(`${name}: synchronizing output`);
        syncOutput();
        const measurement = await measureCase(name, scale, denoise, options, output, reference);
        measurements.push(measurement);
        cases.push(measurement.result);
      }
      // Resolve within each variant/denoise group, regardless of scale order.
      const full = measurements.find(entry => entry.result.scale === 1);
      if (full !== undefined) {
        for (const { result, mean } of measurements) {
          let difference = 0;
          for (let i = 0; i < mean.length; i++) difference += Math.abs(mean[i] - full.mean[i]);
          result.biasVsFull = difference / mean.length;
        }
      }
    }
  }
  return { passed: true, backend, width, height, view, preset, only, warmup, frames, blurs, ao, denoiser, orbit, ref, variants, cases };
}

try {
  const result = await run();
  const table = formatTable(result.cases, result.blurs, result.ref !== null);
  Object.assign(window, { flickerRegression: { ...result, tableTsv: table.tsv } });
  document.querySelector("#status")!.textContent =
    `Measurement complete — ${result.backend}, ${result.width}×${result.height}, ${result.view}, ${result.preset}\n` +
    `AO-only: ${Number(result.only)}, warmup: ${result.warmup}, measured frames: ${result.frames}\n` +
    `ao: ${JSON.stringify(result.ao)}, denoiser: ${JSON.stringify(result.denoiser)}, blurs: ${result.blurs.join(",")}\n\n` +
    table.text;
} catch (error) {
  const result = { passed: false, error: String(error) };
  Object.assign(window, { flickerRegression: result });
  document.querySelector("#status")!.textContent = JSON.stringify(result);
} finally {
  renderer.setAnimationLoop(null);
  renderer.setRenderTarget(null);
  target?.dispose();
  noiseTexture?.dispose();
}
