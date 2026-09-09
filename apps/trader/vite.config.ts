import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3002,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.AURKA_SERVICE_URL ?? "http://127.0.0.1:8787",
        rewrite: (path) => path.replace(/^\/api/, ""),
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3002,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.AURKA_SERVICE_URL ?? "http://127.0.0.1:8787",
        rewrite: (path) => path.replace(/^\/api/, ""),
        changeOrigin: true,
      },
    },
  },
});
