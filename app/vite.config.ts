import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Route components are loaded only when opened. The chat/computer stack is large and should not
  // block the roster, sign-in screen or employee editor on first paint.
  plugins: [
    tanstackRouter({ autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    // CopilotKit pins Streamdown 1.x, whose entry eagerly imports Mermaid, KaTeX and Shiki. The app
    // already uses compatible Streamdown 2.x, which loads those renderers only when content needs
    // them. One copy keeps the ordinary chat path hundreds of kilobytes smaller.
    dedupe: ["streamdown"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: Number.parseInt(process.env.APP_PORT ?? "3010", 10),
    strictPort: true,
    proxy: {
      // `ws: true` is required for the live screen. Without it Vite answers the upgrade request with
      // the app's HTML and the socket fails with an opaque error that looks like a server problem.
      "/api": {
        target: `http://localhost:${process.env.SERVER_PORT ?? "3001"}`,
        ws: true,
      },
    },
  },
});
