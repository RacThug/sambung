// Load packages/db/.env before ../src/index constructs the shared pg pool.
//
// The db tests need BOTH connection strings: DATABASE_URL (owner, used by the
// shared `db` export) and APP_DATABASE_URL (app role, used by rls.test.ts). The
// old guard only checked DATABASE_URL, so a shape that set DATABASE_URL but not
// APP_DATABASE_URL skipped the load and died with an opaque SASL error (#81).
//
// Load unconditionally instead - same story as scripts/load-env.ts.
// process.loadEnvFile() never overrides an already-set env var, so a CI or lane
// that exports either URL keeps its value; the file only fills the gaps. CI
// with no .env falls through the catch to the already-set environment.
try {
  process.loadEnvFile();
} catch {
  // no .env file - rely on the already-set environment
}
