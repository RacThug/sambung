import { randomBytes } from 'node:crypto';
import {
  decodeEncryptionKey,
  decryptCredential,
  encryptCredential,
} from './credential-crypto';

// The format contract (migration 0018's CHECKs + the seed both depend on it):
// 12-byte nonce, tag appended to the ciphertext, key = 32 base64 bytes.
describe('credential-crypto', () => {
  const key = randomBytes(32);

  it('round-trips a server key, with a fresh nonce every time', () => {
    const a = encryptCredential('SB-Mid-server-abc123', key);
    const b = encryptCredential('SB-Mid-server-abc123', key);
    expect(a.nonce).toHaveLength(12);
    expect(a.ciphertext.length).toBeGreaterThan(16);
    // GCM's one absolute rule: never the same nonce twice under one key.
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(decryptCredential(a.ciphertext, a.nonce, key)).toBe(
      'SB-Mid-server-abc123',
    );
  });

  it('throws on the wrong key and on a tampered blob - never returns garbage', () => {
    const enc = encryptCredential('SB-Mid-server-abc123', key);
    expect(() =>
      decryptCredential(enc.ciphertext, enc.nonce, randomBytes(32)),
    ).toThrow(/failed authentication/);
    const tampered = Buffer.from(enc.ciphertext);
    tampered[0] ^= 0xff;
    expect(() => decryptCredential(tampered, enc.nonce, key)).toThrow(
      /failed authentication/,
    );
  });

  it('validates the env key shape, naming the variable', () => {
    expect(() => decodeEncryptionKey(undefined)).toThrow(
      /CREDENTIAL_ENCRYPTION_KEY/,
    );
    expect(() => decodeEncryptionKey('too-short')).toThrow(
      /CREDENTIAL_ENCRYPTION_KEY/,
    );
    expect(
      decodeEncryptionKey(randomBytes(32).toString('base64')),
    ).toHaveLength(32);
  });
});
