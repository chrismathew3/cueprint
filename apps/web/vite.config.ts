import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { youtube } from "./server/youtube.ts";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

// Demo sets are symlinked into public/demo for local dev only; never ship them.
const dropDemos = { name: "drop-demos", apply: "build" as const, closeBundle() { rmSync(resolve(__dirname, "dist/demo"), { recursive: true, force: true }); } };

// COOP/COEP make the page cross-origin isolated so DSP workers can share PCM via SharedArrayBuffer.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "./",
  plugins: [youtube(), dropDemos, react({ babel: { plugins: [["babel-plugin-react-compiler", {}]] } })],
  server: { headers: isolation, fs: { allow: ["../.."] } },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: { target: "es2024", sourcemap: true },
  optimizeDeps: { exclude: ["@mediapipe/tasks-vision"] },
});
