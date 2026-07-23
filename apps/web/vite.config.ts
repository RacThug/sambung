import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Lane isolation for the e2e harness (#167): the dev-server port and the /api
// proxy target are env-driven so N e2e stacks can run in parallel without
// colliding on 5173 / :3000. Unset -> today's exact values, so `pnpm dev` and
// prod are byte-for-byte unchanged (`vite build` ignores `server.*` entirely).
//
// Deliberately NOT named VITE_*: a VITE_-prefixed var is, by Vite's contract,
// exposed to the client bundle through import.meta.env. These are dev-server
// INFRA that must never be baked into a shipped SPA - a VITE_ name would invite
// exactly that leak. Read from process.env here in the Node-side config, they
// stay off the client.
const DEV_PORT = Number(process.env.WEB_DEV_PORT) || 5173;
const API_PROXY_TARGET =
  process.env.WEB_API_PROXY_TARGET || "http://localhost:3000";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@/x` -> `src/x` (shadcn convention). Mirrored in tsconfig.app.json paths.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
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
  // Emit dist/.vite/manifest.json so the bundle-size guard (scripts/check-bundle.mjs,
  // #125) can read the real module graph - which chunks a route pulls - instead of
  // guessing from filenames. Costs one small JSON file; no effect on the SPA.
  build: { manifest: true },
  server: {
    port: DEV_PORT,
    // Fail loudly when the port is taken instead of silently moving to +1. Vite's
    // default is to relocate, which is friendly right up until something else is
    // already serving on 5173 - a stray `pnpm dev` from another worktree, say.
    // Then the URL everything hardcodes (docs/demo.md names localhost:5173 five
    // times; the API allows exactly that origin for bucket CORS via WEB_ORIGIN)
    // points at the WRONG app, and nothing in the log says so. A demo that
    // refuses to start beats a demo that opens somebody else's dashboard.
    strictPort: true,
    // Dev proxy: the SPA calls /api/* and Vite forwards to the NestJS API.
    // Keeps the FE→API boundary explicit and dodges CORS in dev.
    proxy: {
      "/api": {
        target: API_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
});
