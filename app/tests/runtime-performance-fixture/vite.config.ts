import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fixtureRoot = fileURLToPath(new URL(".", import.meta.url));
const appSource = fileURLToPath(new URL("../../src", import.meta.url));

export default defineConfig({
  root: fixtureRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": appSource },
    dedupe: ["react", "react-dom", "streamdown"],
  },
  build: {
    emptyOutDir: true,
    minify: "esbuild",
    outDir: process.env.RUNTIME_PERF_OUT_DIR ?? path.join(fixtureRoot, "dist"),
    sourcemap: false,
  },
});
