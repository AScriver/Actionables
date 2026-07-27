import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiOrigin = `http://127.0.0.1:${process.env.API_PORT ?? "4174"}`;

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
