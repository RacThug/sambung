import { defineConfig } from "vitest/config";

// Standalone test config: when this file exists, vitest ignores vite.config.ts,
// so the dev-only plugins (react fast refresh, tailwind) never load in tests.
// esbuild handles the JSX transform on its own.
export default defineConfig({
  test: {
    environment: "jsdom",
  },
});
