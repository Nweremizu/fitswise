import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;
const root = import.meta.dirname;
// The detailed model is never in the public repo. FITSWISE_PRIVATE=1 builds with it.
const model = process.env.FITSWISE_PRIVATE ? "private/model/dist" : "src/assets/model";

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@model": path.resolve(root, model),
      "@": path.resolve(root, "./src"),
    },
  },

  build: {
    target: "chrome120",
    rollupOptions: { input: [path.resolve(root, "index.html"), path.resolve(root, "popup.html")] },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
