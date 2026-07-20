import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone test config: when this file exists, vitest ignores vite.config.ts,
// so the dev-only plugins (react fast refresh, tailwind) never load in tests.
// esbuild handles the JSX transform on its own.
export default defineConfig({
  test: {
    environment: "jsdom",
    // Raise the async query + per-test timeouts so a code-split route's first
    // cold chunk transform (#125) doesn't flake. See src/test-setup.ts.
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 20_000,
  },
  // `@/x` -> `src/x`, mirrored from vite.config so components resolved by the
  // dev/build alias also resolve under vitest (which ignores vite.config).
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
