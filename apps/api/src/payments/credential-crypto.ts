import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { InternalServerErrorException } from '@nestjs/common';

/**
 * AES-256-GCM for the tenant payment credentials (REQ-PA-04, ADR-0039 decision
 * 3, migration 0018). Pure functions over explicit key material - no config
 * reads in here, so the format is testable in isolation and the seed can
 * produce compatible rows.
 *
 * THE FORMAT (the contract with migration 0018's CHECKs and the seed):
 *   - `nonce`: 12 random bytes, fresh per encryption (GCM's requirement - a
 *     nonce reuse under one key breaks GCM entirely, which is why encrypt takes
 *     no nonce parameter: there is no API to get it wrong with).
 *   - `ciphertext`: the GCM output with the 16-byte auth tag APPENDED - one
 *     opaque blob, one column, and the 0018 CHECK (`> 16 bytes`) knows it.
 *
 * The key is 32 base64-encoded bytes in CREDENTIAL_ENCRYPTION_KEY. Losing it
 * bricks every tenant's checkout - docs/runbooks/credential-key.md is the
 * generate/backup/rotate procedure, and validate-env refuses a deployment
 * without the var. `key_version` on the row names which key encrypted it; this
 * module takes the resolved key, the caller owns the version bookkeeping.
 */

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Decode and validate the env-provided key. Throws a 500-shaped error naming
 * the variable: a bad key is OURS to fix, and it must never read as a client
 * error or a silent fallback (there is no shared key to fall back to).
 */
export function decodeEncryptionKey(value: string | undefined): Buffer {
  const raw = value?.trim() ?? '';
  const key = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (key.length !== KEY_BYTES) {
    throw new InternalServerErrorException(
      'CREDENTIAL_ENCRYPTION_KEY is unset or not 32 base64-encoded bytes - ' +
        'payment credentials cannot be read or written. See docs/runbooks/credential-key.md',
    );
  }
  return key;
}

export interface EncryptedCredential {
  ciphertext: Buffer;
  nonce: Buffer;
}

export function encryptCredential(
  plaintext: string,
  key: Buffer,
): EncryptedCredential {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]),
    nonce,
  };
}

/**
 * Decrypt, authenticating the GCM tag. Throws on a wrong key or a tampered
 * blob - never returns garbage, because a silently-wrong server key would turn
 * into signature failures three layers away with no trail back here.
 */
export function decryptCredential(
  ciphertext: Buffer,
  nonce: Buffer,
  key: Buffer,
): string {
  if (ciphertext.length <= TAG_BYTES) {
    throw new InternalServerErrorException(
      'Stored credential ciphertext is too short to carry a GCM tag - a broken write',
    );
  }
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new InternalServerErrorException(
      'Stored credential failed authentication - wrong CREDENTIAL_ENCRYPTION_KEY ' +
        'or a corrupted row. See docs/runbooks/credential-key.md (rotation / recovery)',
    );
  }
}
