import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/dashboard": "http://127.0.0.1:3000",
      "/portal": "http://127.0.0.1:3000",
      "/admin/platform": "http://127.0.0.1:3000",
      "/payments": "http://127.0.0.1:3000",
      "/healthz": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    root: process.cwd(),
  },
});
