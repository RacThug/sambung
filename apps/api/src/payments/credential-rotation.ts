import { eq } from 'drizzle-orm';
import { tenantPaymentCredential, type Db } from '@sambung/db';
import { decryptCredential, encryptCredential } from './credential-crypto';

export interface RotationResult {
  rotated: number;
  /** The generation every rotated row now carries - set
   * CREDENTIAL_ENCRYPTION_KEY_VERSION to this. */
  newVersion: number;
  /**
   * Rows the OLD key could not decrypt, left UNTOUCHED. Per-row rather than
   * abort-on-first: one corrupted row must not block rotating the other 99 -
   * the script reports these loudly and exits non-zero, and each failed
   * tenant's recovery is the runbook's re-paste path.
   */
  failed: Array<{ id: string; reason: string }>;
}

/**
 * The rotation runbook's re-encrypt pass (docs/runbooks/credential-key.md,
 * EARS MIG-03): decrypt every row under the OLD key, re-encrypt under the NEW,
 * bump `key_version` - one row per transaction, so a crash mid-run leaves each
 * row wholly old or wholly new and the run is resumable (a re-run decrypts the
 * already-rotated rows with... the OLD key and fails loudly on them, which is
 * why the script, not this function, filters by version).
 *
 * Runs on the OWNER connection - the same category as CredentialResolver's
 * read, and the app role could not SELECT the ciphertext anyway (0018).
 */
export async function rotateCredentials(
  db: Db,
  oldKey: Buffer,
  newKey: Buffer,
  fromVersion: number,
): Promise<RotationResult> {
  const newVersion = fromVersion + 1;
  const rows = await db
    .select({
      id: tenantPaymentCredential.id,
      ciphertext: tenantPaymentCredential.ciphertext,
      nonce: tenantPaymentCredential.nonce,
      keyVersion: tenantPaymentCredential.keyVersion,
    })
    .from(tenantPaymentCredential);

  let rotated = 0;
  const failed: RotationResult['failed'] = [];
  for (const row of rows) {
    // Resumability: a row already at the new generation is done - skip it
    // rather than fail decrypting new-key ciphertext with the old key.
    if (row.keyVersion >= newVersion) continue;
    let plaintext: string;
    try {
      plaintext = decryptCredential(row.ciphertext, row.nonce, oldKey);
    } catch (e) {
      failed.push({ id: row.id, reason: String(e) });
      continue;
    }
    const { ciphertext, nonce } = encryptCredential(plaintext, newKey);
    await db.transaction(async (tx) => {
      await tx
        .update(tenantPaymentCredential)
        .set({ ciphertext, nonce, keyVersion: newVersion })
        .where(eq(tenantPaymentCredential.id, row.id));
    });
    rotated += 1;
  }
  return { rotated, newVersion, failed };
}
