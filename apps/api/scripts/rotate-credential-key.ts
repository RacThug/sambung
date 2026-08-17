/**
 * Rotate the credential encryption key (docs/runbooks/credential-key.md).
 *
 *   CREDENTIAL_ENCRYPTION_KEY       - the OLD key (still live)
 *   CREDENTIAL_ENCRYPTION_KEY_NEXT  - the NEW key to rotate onto
 *
 *   pnpm --filter api credentials:rotate
 *
 * Re-encrypts every tenant_payment_credential row, one transaction each
 * (resumable - re-running skips rows already on the new generation), then
 * prints the two env changes to make: move _NEXT into the main var, and set
 * CREDENTIAL_ENCRYPTION_KEY_VERSION to the printed generation.
 *
 * Boots no Nest app; connects as the DB owner (DATABASE_URL) - the app role
 * cannot read the ciphertext (migration 0018), which is the point.
 */
import './../src/load-env'; // must be first: CREDENTIAL_* + DATABASE_URL into process.env
import { createDb } from '@sambung/db';
import { decodeEncryptionKey } from '../src/payments/credential-crypto';
import { rotateCredentials } from '../src/payments/credential-rotation';

async function main() {
  const oldKey = decodeEncryptionKey(process.env.CREDENTIAL_ENCRYPTION_KEY);
  const newKey = decodeEncryptionKey(
    process.env.CREDENTIAL_ENCRYPTION_KEY_NEXT,
  );
  const fromVersion = Number(
    process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION ?? '1',
  );
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY_VERSION must be a positive integer',
    );
  }

  const conn = createDb(process.env.DATABASE_URL ?? '');
  try {
    const result = await rotateCredentials(
      conn.db,
      oldKey,
      newKey,
      fromVersion,
    );
    console.log(
      `Rotated ${result.rotated} credential(s) to key generation ${result.newVersion}.`,
    );
    for (const f of result.failed) {
      console.error(
        `FAILED (left untouched): credential ${f.id} - ${f.reason}. ` +
          "The old key cannot read this row; that tenant's owner must re-paste their key.",
      );
    }
    console.log(
      'Now: set CREDENTIAL_ENCRYPTION_KEY to the NEW key, set ' +
        `CREDENTIAL_ENCRYPTION_KEY_VERSION=${result.newVersion}, remove ` +
        'CREDENTIAL_ENCRYPTION_KEY_NEXT, restart the api, and update the key backups.',
    );
    if (result.failed.length > 0) process.exitCode = 1;
  } finally {
    await conn.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
