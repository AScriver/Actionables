import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const inlineResource: Plugin = {
  name: "inline-mcp-review-resource",
  // Vite emits combined CSS in generateBundle; inline it after that hook.
  enforce: "post",
  generateBundle(_options, bundle) {
    const javascript: string[] = [];
    const css: string[] = [];
    for (const [name, output] of Object.entries(bundle)) {
      if (output.type === "chunk") javascript.push(output.code);
      else if (name.endsWith(".css")) css.push(String(output.source));
      else throw new Error(`Unexpected external review asset: ${name}`);
      delete bundle[name];
    }
    this.emitFile({
      type: "asset",
      fileName: "review.html",
      source: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>Actionable review</title><style>${css.join("\n").replace(/<\/style/gi, "<\\/style")}</style></head><body><div id="root"></div><script>${javascript.join("\n").replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
    });
  },
};
export default defineConfig({
  plugins: [react(), inlineResource],
  // The SDK transport logs complete messages by default; never log review payloads.
  define: {
    "process.env.NODE_ENV": '"production"',
    "console.debug": "(()=>{})",
    "console.error": "(()=>{})",
    "console.warn": "(()=>{})",
  },
  build: {
    outDir: process.env.CHATGPT_UI_OUT_DIR ?? "dist/chatgpt",
    emptyOutDir: false,
    lib: {
      entry: "src/chatgpt-review.tsx",
      name: "ActionableReview",
      formats: ["iife"],
    },
    cssCodeSplit: false,
  },
});
