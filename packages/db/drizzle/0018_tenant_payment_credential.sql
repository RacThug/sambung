-- ▼▼▼ Per-tenant payment credentials (REQ-PA-04, ADR-0039, PRD-product P0-6) ▼▼▼
-- The Tenant's own Midtrans server key, AES-256-GCM-encrypted under the app-held
-- CREDENTIAL_ENCRYPTION_KEY. Guest money settles into the OWNER's account;
-- Sambung is never in the money path. One row per (tenant, provider); replace is
-- the same idempotent upsert. See the grants at the bottom for the load-bearing
-- part: the app role cannot SELECT the secret columns, by privilege.
CREATE TABLE "tenant_payment_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"last_verify_status" text DEFAULT 'unchecked' NOT NULL,
	"last_verify_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_payment_credential_tenant_provider_uniq" UNIQUE("tenant_id","provider"),
	CONSTRAINT "tenant_payment_credential_environment" CHECK ("tenant_payment_credential"."environment" in ('sandbox', 'production')),
	CONSTRAINT "tenant_payment_credential_verify_status" CHECK ("tenant_payment_credential"."last_verify_status" in ('ok', 'failed', 'unchecked')),
	CONSTRAINT "tenant_payment_credential_nonce_len" CHECK (octet_length("tenant_payment_credential"."nonce") = 12),
	CONSTRAINT "tenant_payment_credential_ciphertext_len" CHECK (octet_length("tenant_payment_credential"."ciphertext") > 16),
	CONSTRAINT "tenant_payment_credential_key_version" CHECK ("tenant_payment_credential"."key_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "tenant_payment_credential" ADD CONSTRAINT "tenant_payment_credential_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
-- ▼▼▼ RLS - hand-written like every policy (#74) ▼▼▼
-- FLAT tenant term, both halves, fail-closed (0002's nullif form). No property
-- axis: a credential is the shape of the Tenant's money (the ADR-0032 verb line),
-- @Roles('owner') owns the role question, and the staff_invite policy set the
-- precedent. The row the app role can see through this policy is already
-- stripped of its secret columns by the grants below.
ALTER TABLE "tenant_payment_credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_payment_credential"
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- ▼▼▼ The write-only grant (EARS CR-06) - the part that makes it structural ▼▼▼
-- sambung_app may INSERT/UPDATE every column (the PUT writes ciphertext) but may
-- SELECT only the non-secret ones: `REVOKE SELECT` then a COLUMN-LEVEL grant. So
-- no principal-scoped query - Visitor, Staff, Owner, or a compromised one - can
-- ever read secret material; the decrypting read runs on the OWNER connection at
-- the gateway layer, which these grants do not bind.
--
-- TWO copies of this column list exist, forced by boot order: on a fresh database
-- `db:migrate` runs before `db:setup-role` (this block no-ops, the role does not
-- exist yet) and setup-app-role.ts's blanket `GRANT ... ON ALL TABLES` would
-- otherwise re-open full SELECT - so that script re-applies the same restriction
-- after its grant. The pair is pinned by the behavioural test in
-- test/payment-credential.test.ts (the app role's `SELECT ciphertext` must fail),
-- which is the one authority over both copies.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'sambung_app') THEN
    GRANT INSERT, UPDATE, DELETE ON TABLE "tenant_payment_credential" TO "sambung_app";
    REVOKE SELECT ON TABLE "tenant_payment_credential" FROM "sambung_app";
    GRANT SELECT ("id", "tenant_id", "provider", "environment", "key_version", "last_verify_status", "last_verify_at", "created_at", "updated_at")
      ON "tenant_payment_credential" TO "sambung_app";
  END IF;
END $$;