import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone test config: when this file exists, vitest ignores vite.config.ts,
// so the dev-only plugins (react fast refresh, tailwind) never load in tests.
// esbuild handles the JSX transform on its own.
export default defineConfig({
  test: {
    environment: "jsdom",
  },
  // `@/x` -> `src/x`, mirrored from vite.config so components resolved by the
  // dev/build alias also resolve under vitest (which ignores vite.config).
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
