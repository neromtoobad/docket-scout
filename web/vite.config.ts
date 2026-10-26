import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5186, proxy: { "/api": "http://localhost:8030", "/run": "http://localhost:8030" } },
});
