import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Load DATABASE_URL before PrismaClient is constructed.
    setupFiles: ["./test/setup.ts"],
    // DB round-trips + a real connection — give them room.
    testTimeout: 20000,
    hookTimeout: 30000,
    // These tests share one database; run files serially.
    fileParallelism: false,
  },
});
