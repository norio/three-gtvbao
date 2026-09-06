import { StatsProfiler } from "stats-gl";

export function createFpsStats() {
  const profiler = new StatsProfiler();
  const dom = document.createElement("span");
  dom.id = "fps-stats";
  dom.textContent = "—fps";
  document.querySelector("#render-metrics")?.prepend(dom);
  let lastDisplayTime = performance.now();

  return {
    dom,
    update() {
      profiler.update();
      const now = performance.now();
      // Keep the text readable while measuring every rendered frame.
      if (now - lastDisplayTime < 250) return;
      dom.textContent = `${Math.round(profiler.getData().fps)}fps`;
      lastDisplayTime = now;
    },
  };
}
