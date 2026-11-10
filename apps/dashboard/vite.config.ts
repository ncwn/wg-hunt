import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Host header is kept as is, so the cookie-authenticated writes' Origin check still passes.
const apiTarget = `http://127.0.0.1:${process.env.WG_HUNT_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": apiTarget } },
  build: { outDir: "dist", emptyOutDir: true },
});
