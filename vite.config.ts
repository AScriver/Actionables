import { resolveRuntimeConfig } from "@actionables/contracts";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const runtimeConfig = resolveRuntimeConfig({
  webPort: process.env.WEB_PORT,
  apiPort: process.env.API_PORT,
});

export default defineConfig({
  plugins: [react()],
  server: {
    host: runtimeConfig.webHost,
    port: runtimeConfig.webPort,
    strictPort: true,
    proxy: {
      "/api": runtimeConfig.apiOrigin,
    },
  },
  preview: {
    host: runtimeConfig.webHost,
    port: runtimeConfig.webPort,
    strictPort: true,
    proxy: {
      "/api": runtimeConfig.apiOrigin,
    },
  },
});
