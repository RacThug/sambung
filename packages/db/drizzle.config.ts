import { defineConfig } from "drizzle-kit";

// drizzle-kit does not auto-load .env; Node 20.12+ can.
try {
  process.loadEnvFile();
} catch {
  // no .env file - rely on the already-set environment
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Owner connection - migrations always run as the owner (bypasses RLS).
    url: process.env.DATABASE_URL!,
  },
});
