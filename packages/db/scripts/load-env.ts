// Imported FIRST by every script so DATABASE_URL is in process.env before
// ../src/index constructs the shared pg pool.
try {
  process.loadEnvFile();
} catch {
  // no .env file - rely on the already-set environment
}
