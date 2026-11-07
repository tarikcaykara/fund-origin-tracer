import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      // SSE streams are long-lived: no proxy timeout, and no response buffering. The API listens
      // on IPv4 loopback only, and `localhost` may resolve to ::1 first.
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: true, timeout: 0, proxyTimeout: 0 },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
