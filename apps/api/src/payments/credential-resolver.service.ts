import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { tenantPaymentCredential } from '@sambung/db';
import { paymentEnvironmentSchema } from '@sambung/shared';
import { paymentsNotConfigured } from '../common/db-error/conflicts';
import { DbService } from '../db/db.service';
import { decodeEncryptionKey, decryptCredential } from './credential-crypto';
import type { GatewayCredential, PaymentGateway } from './payment-gateway';

/**
 * What a credential-free gateway (the fake) runs with: the seam simulates a
 * fully-configured provider, so every caller gets ONE stand-in from ONE place
 * rather than inventing its own.
 */
const FAKE_CREDENTIAL: GatewayCredential = {
  serverKey: 'fake',
  environment: 'sandbox',
};

/**
 * The ONE place secret credential material is read and decrypted (REQ-PA-04,
 * EARS CR-06). Runs on the OWNER connection (DbService) - the sweeper/webhook
 * category: a system read of platform configuration, keyed by a tenant id the
 * caller already resolved, not an actor browsing. Deliberately NOT the
 * tenant-scoped client, twice over: migration 0018 revoked the app role's
 * SELECT on the secret columns (so this read is IMPOSSIBLE there - the grant is
 * the guarantee, this placement just complies with it), and a Visitor-scoped
 * pay request must never have a code path that could return a key.
 *
 * The decrypted key lives only in the returned value, handed straight to the
 * gateway call - never logged, never on a response, never cached.
 */
@Injectable()
export class CredentialResolver {
  constructor(
    private readonly dbs: DbService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The tenant's credential for `provider`, decrypted - or null when none is
   * stored. Null is a SUPPORTED state (ADR-0039 decision 4): the webhook and
   * reconcile skip verification rather than error (EARS WH-04).
   */
  async maybeResolve(
    tenantId: string,
    provider = 'midtrans',
  ): Promise<GatewayCredential | null> {
    const rows = await this.dbs.db
      .select({
        ciphertext: tenantPaymentCredential.ciphertext,
        nonce: tenantPaymentCredential.nonce,
        environment: tenantPaymentCredential.environment,
      })
      .from(tenantPaymentCredential)
      .where(
        and(
          eq(tenantPaymentCredential.tenantId, tenantId),
          eq(tenantPaymentCredential.provider, provider),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const key = decodeEncryptionKey(
      this.config.get<string>('CREDENTIAL_ENCRYPTION_KEY'),
    );
    return {
      serverKey: decryptCredential(row.ciphertext, row.nonce, key),
      // The CHECK (0018) guarantees the value; the parse keeps the type honest
      // without a cast that would outlive the constraint.
      environment: paymentEnvironmentSchema.parse(row.environment),
    };
  }

  /** As maybeResolve, but a missing credential is the funnel's 409 (EARS GW-02). */
  async resolveOrThrow(
    tenantId: string,
    provider = 'midtrans',
  ): Promise<GatewayCredential> {
    const credential = await this.maybeResolve(tenantId, provider);
    if (!credential) {
      throw paymentsNotConfigured();
    }
    return credential;
  }

  /** The one stand-in a credential-free gateway (the fake, EARS GW-06) runs
   * with - so no caller invents its own. */
  fakeCredential(): GatewayCredential {
    return FAKE_CREDENTIAL;
  }

  /**
   * Gateway-aware resolution: a credential-free gateway gets the stand-in; the
   * real one resolves the tenant's row or throws the funnel's 409 (GW-02).
   */
  forGatewayOrThrow(
    gateway: Pick<PaymentGateway, 'requiresCredentials'>,
    tenantId: string,
  ): Promise<GatewayCredential> {
    if (!gateway.requiresCredentials) return Promise.resolve(FAKE_CREDENTIAL);
    return this.resolveOrThrow(tenantId);
  }
}
