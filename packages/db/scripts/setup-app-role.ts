/**
 * Create the non-owner application role `sambung_app` and grant it DML on the
 * schema. The app connects as this role at runtime so RLS policies apply (the
 * owner bypasses RLS). Run AFTER migrations:
 *
 *   pnpm --filter @sambung/db db:setup-role
 *
 * Idempotent. Dev/infra only - runs as the owner (DATABASE_URL). In production
 * the role + password are provisioned by your platform; override APP_DB_PASSWORD.
 */
import "./load-env";
import { Client } from "pg";

const ROLE = "sambung_app";
const PASSWORD = process.env.APP_DB_PASSWORD ?? "sambung_app";

const statements = [
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
       CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';
     END IF;
   END $$;`,
  `GRANT USAGE ON SCHEMA public TO ${ROLE};`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE};`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE};`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE};`,
  // tenant_payment_credential is WRITE-ONLY for the app role (REQ-PA-04,
  // migration 0018): the blanket grant above just re-opened full SELECT, so the
  // column restriction is re-applied here - the app role may never read the
  // secret columns (ciphertext, nonce); the decrypting read runs on the OWNER
  // connection only. This is the SECOND copy of the column list (the first is in
  // 0018, which no-ops on a fresh database because this role does not exist yet
  // when migrations run); the pair is pinned by the behavioural test in
  // test/payment-credential.test.ts, which is the one authority over both.
  `DO $$ BEGIN
     IF EXISTS (SELECT FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'tenant_payment_credential') THEN
       REVOKE SELECT ON TABLE tenant_payment_credential FROM ${ROLE};
       GRANT SELECT (id, tenant_id, provider, environment, key_version, last_verify_status, last_verify_at, created_at, updated_at)
         ON tenant_payment_credential TO ${ROLE};
     END IF;
   END $$;`,
];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
    console.log(`Role ${ROLE} ready; DML grants applied.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
