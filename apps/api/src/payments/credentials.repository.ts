import { Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { tenantPaymentCredential } from '@sambung/db';
import type {
  CredentialVerifyStatus,
  PaymentEnvironment,
  PaymentProvider,
} from '@sambung/shared';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

/** A status row - every column the app role may SELECT (migration 0018's
 * column grant), and not one more. */
export interface CredentialStatusRow {
  provider: string;
  environment: string;
  createdAt: Date;
  lastVerifyStatus: string;
  lastVerifyAt: Date | null;
}

/**
 * The dashboard's half of the credential store (REQ-PA-04), on the tenant-scoped
 * (RLS) client. EVERY select here names its columns explicitly and never the
 * secret ones - not as politeness: migration 0018 revoked the app role's SELECT
 * on `ciphertext`/`nonce`, so a `select()` that defaulted to all columns would
 * be a runtime 42501. Writes may carry ciphertext (the PUT encrypts before
 * calling in); the role can write what it can never read back.
 *
 * The decrypting read lives in CredentialResolver on the OWNER connection - the
 * one place secret material is touched, and deliberately not here.
 */
@Injectable()
export class CredentialsRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  statusList(): Promise<CredentialStatusRow[]> {
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select({
          provider: tenantPaymentCredential.provider,
          environment: tenantPaymentCredential.environment,
          createdAt: tenantPaymentCredential.createdAt,
          lastVerifyStatus: tenantPaymentCredential.lastVerifyStatus,
          lastVerifyAt: tenantPaymentCredential.lastVerifyAt,
        })
        .from(tenantPaymentCredential)
        .where(eq(tenantPaymentCredential.tenantId, tenantId))
        .orderBy(asc(tenantPaymentCredential.provider)),
    );
  }

  /** The funnel gate's question (EARS GW-03/04): does ANY credential exist for
   * this tenant? Reads only `id` - the cheapest granted column. */
  async existsForTenant(): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ id: tenantPaymentCredential.id })
        .from(tenantPaymentCredential)
        .where(eq(tenantPaymentCredential.tenantId, tenantId))
        .limit(1),
    );
    return rows.length > 0;
  }

  /**
   * The PUT's write (EARS CR-01): one row per (tenant, provider), replace is the
   * same idempotent upsert. `key_version` resets to the CURRENT key's version on
   * every write - a replace is always encrypted under the key of the day.
   * No `.returning()`: the app role could only return granted columns anyway,
   * and the caller re-reads through statusList.
   */
  async upsert(values: {
    provider: PaymentProvider;
    environment: PaymentEnvironment;
    ciphertext: Buffer;
    nonce: Buffer;
    keyVersion: number;
    lastVerifyStatus: CredentialVerifyStatus;
    lastVerifyAt: Date;
  }): Promise<void> {
    const tenantId = this.tenant.tenantId;
    await this.db.run((tx) =>
      tx
        .insert(tenantPaymentCredential)
        .values({ ...values, tenantId })
        .onConflictDoUpdate({
          target: [
            tenantPaymentCredential.tenantId,
            tenantPaymentCredential.provider,
          ],
          set: {
            environment: values.environment,
            ciphertext: values.ciphertext,
            nonce: values.nonce,
            keyVersion: values.keyVersion,
            lastVerifyStatus: values.lastVerifyStatus,
            lastVerifyAt: values.lastVerifyAt,
            updatedAt: sql`now()`,
          },
        }),
    );
  }
}
