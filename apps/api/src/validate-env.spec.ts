import { validateEnv } from './validate-env';

/**
 * The boot-time config guard (#127 review follow-up, extended by #68/ADR-0029).
 * Every rule it enforces is production-only and guards a mis-set with NO
 * observable symptom on the server. The guard is a pure function of its env
 * argument, so it is exercised directly with a fake env - the shape main.ts
 * hands it (process.env) - mirroring `mailer.factory.spec`.
 */

/** A prod env that satisfies every rule; each test breaks exactly one. */
const PROD = {
  NODE_ENV: 'production',
  WEB_BASE_URL: 'https://sambung.example',
  STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
} satisfies NodeJS.ProcessEnv;

describe('validateEnv', () => {
  it('throws in production when WEB_BASE_URL is unset', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(
      /WEB_BASE_URL/,
    );
  });

  it('throws in production when WEB_BASE_URL is blank', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'production', WEB_BASE_URL: '   ' }),
    ).toThrow(/WEB_BASE_URL/);
  });

  it('passes in production when WEB_BASE_URL is set', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        WEB_BASE_URL: 'https://sambung.example',
      }),
    ).not.toThrow();
  });

  it('does not require WEB_BASE_URL outside production (fallback preserved)', () => {
    expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => validateEnv({ NODE_ENV: 'test' })).not.toThrow();
    // NODE_ENV unset is not production either.
    expect(() => validateEnv({})).not.toThrow();
  });

  // --- The storage cutover guards (#68, ADR-0029) ---

  describe('STORAGE_PUBLIC_BASE_URL', () => {
    it.each([
      // The dev default, verbatim from .env.example - the exact value a
      // half-swapped cutover leaves behind.
      'http://sambung-photos.web.garage.localhost:3902',
      'http://localhost:3902',
      'http://127.0.0.1:3902',
      'http://[::1]:3902',
      // https but still loopback: the protocol alone is not the test.
      'https://localhost:3902',
      // Public host but plain http: blocked as mixed content on an https site.
      'http://photos.sambung.example',
    ])('refuses %s in production', (url) => {
      expect(() =>
        validateEnv({ ...PROD, STORAGE_PUBLIC_BASE_URL: url }),
      ).toThrow(/STORAGE_PUBLIC_BASE_URL/);
    });

    it('refuses a malformed URL in production', () => {
      expect(() =>
        validateEnv({ ...PROD, STORAGE_PUBLIC_BASE_URL: 'photos.example' }),
      ).toThrow(/not a valid URL/);
    });

    it('accepts an https, non-loopback origin', () => {
      expect(() =>
        validateEnv({
          ...PROD,
          STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
        }),
      ).not.toThrow();
    });

    it('leaves the dev default alone outside production', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'development',
          STORAGE_PUBLIC_BASE_URL:
            'http://sambung-photos.web.garage.localhost:3902',
          STORAGE_BOOTSTRAP: 'true',
        }),
      ).not.toThrow();
    });
  });

  describe('STORAGE_BOOTSTRAP', () => {
    it('refuses "true" in production (R2 supports neither call it makes)', () => {
      expect(() => validateEnv({ ...PROD, STORAGE_BOOTSTRAP: 'true' })).toThrow(
        /STORAGE_BOOTSTRAP/,
      );
    });

    it('accepts it unset or explicitly off', () => {
      expect(() => validateEnv(PROD)).not.toThrow();
      expect(() =>
        validateEnv({ ...PROD, STORAGE_BOOTSTRAP: 'false' }),
      ).not.toThrow();
    });
  });

  // --- The e2e payment-gateway seam guard (#167 part b) ---

  describe('PAYMENT_GATEWAY', () => {
    it('refuses "fake" in production (would confirm fabricated payments)', () => {
      expect(() => validateEnv({ ...PROD, PAYMENT_GATEWAY: 'fake' })).toThrow(
        /PAYMENT_GATEWAY/,
      );
    });

    it('accepts it unset or set to the real gateway in production', () => {
      expect(() => validateEnv(PROD)).not.toThrow();
      expect(() =>
        validateEnv({ ...PROD, PAYMENT_GATEWAY: 'midtrans' }),
      ).not.toThrow();
    });

    it('leaves "fake" alone outside production (the e2e stack sets it)', () => {
      expect(() =>
        validateEnv({ NODE_ENV: 'test', PAYMENT_GATEWAY: 'fake' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ NODE_ENV: 'development', PAYMENT_GATEWAY: 'fake' }),
      ).not.toThrow();
    });
  });
});
