import { defineConfig } from "vite";

// Serves and builds the example only; the library itself ships as plain ESM
// from src/ with no build step.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    // The example uses top-level await for renderer.init().
    target: "esnext",
    chunkSizeWarningLimit: 1200,
  },
  server: {
    host: true,
  },
});
