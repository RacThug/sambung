// Load apps/api/.env (DATABASE_URL + JWT secrets) before test modules evaluate.
// CI can set these env vars directly instead.
try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on the already-set environment
}
