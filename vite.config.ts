import { resolveApiRuntimeConfig } from "@actionables/contracts";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const { apiOrigin } = resolveApiRuntimeConfig(process.env.API_PORT);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": apiOrigin,
    },
  },
  preview: {
    proxy: {
      "/api": apiOrigin,
    },
  },
});
