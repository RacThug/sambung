// Imported FIRST in main.ts so DATABASE_URL + JWT secrets are in process.env
// before any module (e.g. @sambung/db's PrismaClient) is evaluated.
try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on the already-set environment (e.g. CI)
}
