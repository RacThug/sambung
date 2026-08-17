import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, createDb, db, pgError } from "../src/index";
import { tenant, tenantPaymentCredential } from "../src/schema";
import { expectDbError } from "./helpers";

// Migration 0018 (REQ-PA-04, ADR-0039): the CHECK backstops, the upsert target,
// and - the one that matters most - the WRITE-ONLY column grants. The grant test
// is the single authority over BOTH copies of the column list (migration 0018
// and setup-app-role.ts): whichever ran last, the app role must not be able to
// read secret material.

const NONCE = Buffer.alloc(12, 7);
const CIPHERTEXT = Buffer.alloc(48, 9); // > 16 bytes (includes the GCM tag)

let tenantA: string;

const validRow = () => ({
  tenantId: tenantA,
  provider: "midtrans",
  environment: "sandbox",
  ciphertext: CIPHERTEXT,
  nonce: NONCE,
});

beforeAll(async () => {
  const [t] = await db
    .insert(tenant)
    .values({ name: "Tenant (payment credential)" })
    .returning({ id: tenant.id });
  tenantA = t.id;
});

afterAll(async () => {
  await db.delete(tenant).where(eq(tenant.id, tenantA));
  await closeDb();
});

describe("tenant_payment_credential CHECK constraints", () => {
  it("rejects an unknown environment - wrongness here is silent (wrong base URL)", async () => {
    await expectDbError(
      db
        .insert(tenantPaymentCredential)
        .values({ ...validRow(), environment: "staging" }),
      "23514",
      "tenant_payment_credential_environment",
    );
  });

  it("rejects a nonce that is not 12 bytes and a ciphertext too short to be real", async () => {
    await expectDbError(
      db
        .insert(tenantPaymentCredential)
        .values({ ...validRow(), nonce: Buffer.alloc(8, 1) }),
      "23514",
      "tenant_payment_credential_nonce_len",
    );
    // 16 bytes is exactly the GCM tag - an empty plaintext, which no real key is.
    await expectDbError(
      db
        .insert(tenantPaymentCredential)
        .values({ ...validRow(), ciphertext: Buffer.alloc(16, 1) }),
      "23514",
      "tenant_payment_credential_ciphertext_len",
    );
  });
});

describe("one credential per (tenant, provider) - replace is an upsert", () => {
  it("a second plain insert collides; ON CONFLICT DO UPDATE replaces in place", async () => {
    await db.insert(tenantPaymentCredential).values(validRow());
    await expectDbError(
      db.insert(tenantPaymentCredential).values(validRow()),
      "23505",
      "tenant_payment_credential_tenant_provider_uniq",
    );
    const replacement = Buffer.alloc(64, 3);
    await db
      .insert(tenantPaymentCredential)
      .values({ ...validRow(), ciphertext: replacement, environment: "production" })
      .onConflictDoUpdate({
        target: [
          tenantPaymentCredential.tenantId,
          tenantPaymentCredential.provider,
        ],
        set: { ciphertext: replacement, nonce: NONCE, environment: "production" },
      });
    const rows = await db
      .select({ environment: tenantPaymentCredential.environment })
      .from(tenantPaymentCredential)
      .where(eq(tenantPaymentCredential.tenantId, tenantA));
    expect(rows).toEqual([{ environment: "production" }]);
  });
});

describe("the app role is WRITE-ONLY on secret columns (EARS CR-06)", () => {
  // The behavioural pin over both copies of the column grant (0018 +
  // setup-app-role.ts). Runs as the REAL app role.
  const appConn = createDb(process.env.APP_DATABASE_URL ?? "");

  afterAll(async () => {
    await appConn.close();
  });

  type Tx = Parameters<Parameters<typeof appConn.db.transaction>[0]>[0];
  const asTenant = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    appConn.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantA}, true),
                   set_config('app.property_scope', 'all', true),
                   set_config('app.staff_user_id', '', true)`,
      );
      return fn(tx);
    });

  it("cannot SELECT ciphertext or nonce - permission denied, not zero rows", async () => {
    for (const col of ["ciphertext", "nonce"] as const) {
      try {
        await asTenant((tx) =>
          tx.execute(
            sql`select ${sql.identifier(col)} from tenant_payment_credential`,
          ),
        );
        expect.unreachable(
          `app role read ${col} - the write-only grant is gone`,
        );
      } catch (e) {
        expect(pgError(e)?.code).toBe("42501"); // insufficient_privilege
      }
    }
  });

  it("can still SELECT the status columns and INSERT a full row", async () => {
    const rows = await asTenant((tx) =>
      tx
        .select({
          provider: tenantPaymentCredential.provider,
          environment: tenantPaymentCredential.environment,
          lastVerifyStatus: tenantPaymentCredential.lastVerifyStatus,
        })
        .from(tenantPaymentCredential),
    );
    expect(rows).toEqual([
      { provider: "midtrans", environment: "production", lastVerifyStatus: "unchecked" },
    ]);

    // The PUT's write path: the app role writes ciphertext it can never read
    // back. A separate provider value so it does not collide with the row above.
    await asTenant((tx) =>
      tx
        .insert(tenantPaymentCredential)
        .values({ ...validRow(), provider: "xendit" }),
    );
    const after = await asTenant((tx) =>
      tx
        .select({ provider: tenantPaymentCredential.provider })
        .from(tenantPaymentCredential)
        .where(eq(tenantPaymentCredential.provider, "xendit")),
    );
    expect(after).toEqual([{ provider: "xendit" }]);
  });
});
