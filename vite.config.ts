import { defineConfig } from "vite";

export default defineConfig({
  server: { proxy: { "/api": process.env.MSC_HUB_URL ?? "http://127.0.0.1:5190" } },
});
