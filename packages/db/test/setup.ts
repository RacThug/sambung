// Make DATABASE_URL available before PrismaClient is constructed.
// Locally we read packages/db/.env; CI can set the env var directly.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file — rely on the already-set environment
  }
}
