import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      assert: fileURLToPath(new URL("./src/shims/assert.js", import.meta.url)),
      buffer: "buffer/",
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        app: fileURLToPath(new URL("./app.html", import.meta.url)),
        docs: fileURLToPath(new URL("./docs.html", import.meta.url)),
        footprint: fileURLToPath(new URL("./footprint.html", import.meta.url)),
        status: fileURLToPath(new URL("./status.html", import.meta.url)),
      },
    },
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: {
    esbuildOptions: { target: "es2022" },
  },
});
