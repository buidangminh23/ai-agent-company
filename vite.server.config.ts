import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    ssr: "server/hub.ts",
    outDir: "dist-server",
    emptyOutDir: true,
    target: "node23",
    minify: false,
    sourcemap: false,
    rollupOptions: { output: { format: "es", entryFileNames: "hub.mjs", chunkFileNames: "[name]-[hash].mjs" } },
  },
});
