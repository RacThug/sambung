import { eq } from 'drizzle-orm';
import { tenantPaymentCredential, type DbTx } from '@sambung/db';

/**
 * Does the tenant hold ANY payment credential? (REQ-PA-04, EARS GW-03/04.)
 * The ONE definition of "online payments are configured" - the public property
 * flag and the public booking gate both call this, so the funnel's advertised
 * state and the write's refusal cannot drift apart.
 *
 * Reads only `id` (the app role's SELECT on the secret columns is revoked -
 * migration 0018 - and existence needs nothing more). Runs inside the caller's
 * tenant-scoped transaction: RLS + the explicit WHERE are the usual two layers.
 */
export async function paymentCredentialExists(
  tx: DbTx,
  tenantId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: tenantPaymentCredential.id })
    .from(tenantPaymentCredential)
    .where(eq(tenantPaymentCredential.tenantId, tenantId))
    .limit(1);
  return rows.length > 0;
}
