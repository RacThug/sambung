import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Load the .env (DATABASE_URL + APP_DATABASE_URL) before the shared pg pool
    // is constructed. See test/setup.ts.
    setupFiles: ["./test/setup.ts"],
    // DB round-trips + a real connection — give them room.
    testTimeout: 20000,
    hookTimeout: 30000,
    // These tests share one database; run files serially.
    fileParallelism: false,
  },
});
