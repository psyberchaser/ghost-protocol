import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ["buffer"],
      globals: {
        Buffer: true,
      },
    }),
  ],
  server: {
    port: 5173,
  },
  define: {
    global: "globalThis",
  },
});
