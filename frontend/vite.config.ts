import { writeFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "keep-static-gitkeep",
      closeBundle() {
        writeFileSync("../src/lucrium_panel/static/.gitkeep", "");
      },
    },
  ],
  build: {
    outDir: "../src/lucrium_panel/static",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
        ws: true,
        headers: { Origin: "http://127.0.0.1:8765" },
      },
    },
  },
});
