import { randomUUID } from 'node:crypto';
import { tenantPaymentCredential, type Db } from '@sambung/db';

/**
 * A throwaway public address for a fixture property.
 *
 * `property.slug` is NOT NULL and GLOBALLY unique (#46), so every fixture that
 * inserts a property directly needs one, even where no test asserts on it.
 * Random per call because these specs run repeatedly against the same dev
 * database - a fixed slug would collide with the previous run rather than with
 * anything the test is trying to prove.
 *
 * Duplicated from packages/db/test/helpers.ts on purpose: that file is inside
 * another package's test folder, which this app cannot import. A one-line test
 * helper is not worth a shared package.
 */
export const testSlug = (): string => `test-${randomUUID()}`;

/**
 * Plant an EXISTENCE-ONLY payment credential for a tenant, so suites that
 * exercise the guest funnel with the REAL gateway bound pass the
 * `payments_not_configured` gate (REQ-PA-04, EARS GW-03/04).
 *
 * The blob is NOT decryptable - filler bytes, not a ciphertext. Deliberate: the
 * gate reads existence only, and any test that needs a DECRYPTABLE credential
 * must go through the real PUT (the credentials spec does), so this fixture can
 * never quietly stand in for the crypto path.
 */
export function insertCredentialFixture(
  db: Db,
  tenantId: string,
): Promise<unknown> {
  return db.insert(tenantPaymentCredential).values({
    tenantId,
    provider: 'midtrans',
    environment: 'sandbox',
    ciphertext: Buffer.alloc(48, 1),
    nonce: Buffer.alloc(12, 1),
  });
}
