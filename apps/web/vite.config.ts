import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // @sambung/shared compiles to CommonJS (tsconfig.base sets module: NodeNext
  // and the package has no "type": "module" - the API is CJS NestJS and needs
  // it that way). Vite does NOT pre-bundle *linked* workspace packages by
  // default, so in dev it served that CJS file to the browser as ESM and every
  // named import failed: "does not provide an export named 'loginRequestSchema'"
  // - a white screen on every page.
  //
  // Listing it here opts it into the dep optimizer, which converts it to ESM the
  // same way Rollup's commonjs plugin already does for `vite build`. Dev-only
  // bug, dev-only fix: production was always fine, which is exactly why nothing
  // caught it - vitest resolves through Node, where CJS just works.
  optimizeDeps: { include: ["@sambung/shared"] },
  server: {
    port: 5173,
    // Dev proxy: the SPA calls /api/* and Vite forwards to the NestJS API.
    // Keeps the FE→API boundary explicit and dodges CORS in dev.
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
