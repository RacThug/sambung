import { validateEnv } from './validate-env';

/**
 * The boot-time config guard (#127 review follow-up, extended by #68/ADR-0029).
 * Every rule it enforces guards a mis-set with NO observable symptom on the
 * server, and applies to any process that cannot prove it is a local sandbox -
 * derived from the browser-facing origins rather than NODE_ENV, which nothing
 * in this repo sets (#193, `deployment-env.ts`). The guard is a pure function of
 * its env argument, so it is exercised directly with a fake env - the shape
 * main.ts hands it (process.env) - mirroring `mailer.factory.spec`.
 */

/** A prod env that satisfies every rule; each test breaks exactly one. */
const PROD = {
  NODE_ENV: 'production',
  WEB_BASE_URL: 'https://sambung.example',
  STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
} satisfies NodeJS.ProcessEnv;

/**
 * The dev shape, verbatim from `.env.example`: every browser-facing origin is
 * loopback, which is what PROVES a local sandbox (#193). NODE_ENV is absent,
 * exactly as `pnpm dev` and the e2e webServer leave it.
 */
const LOCAL = {
  WEB_BASE_URL: 'http://localhost:5173',
  STORAGE_PUBLIC_BASE_URL: 'http://sambung-photos.web.garage.localhost:3902',
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

  it('does not require WEB_BASE_URL on a proven local sandbox (fallback preserved)', () => {
    // "Local" is proven by the browser-facing origins, not by NODE_ENV: every
    // one this process declares is loopback, so no guest browser is being sent
    // anywhere real. NODE_ENV is irrelevant to that (#193).
    expect(() => validateEnv(LOCAL)).not.toThrow();
    expect(() =>
      validateEnv({ ...LOCAL, NODE_ENV: 'development' }),
    ).not.toThrow();
    expect(() => validateEnv({ ...LOCAL, NODE_ENV: 'test' })).not.toThrow();
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

    it('leaves "fake" alone on a proven local sandbox (the e2e stack sets it)', () => {
      expect(() =>
        validateEnv({ ...LOCAL, NODE_ENV: 'test', PAYMENT_GATEWAY: 'fake' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ ...LOCAL, PAYMENT_GATEWAY: 'fake' }),
      ).not.toThrow();
    });
  });

  // --- Deployment detection without NODE_ENV (#193) ---
  //
  // Nothing in this repo sets NODE_ENV=production - `start:prod` is a bare
  // `node dist/main` and there is no Dockerfile - so gating on it alone made
  // every rule above inert on a real deployment. The guards now run unless the
  // process PROVES it is a local sandbox: every browser-facing origin it
  // declares is loopback.

  describe('deployment detection (no NODE_ENV)', () => {
    /** PROD without the declaration - the deployment that forgot NODE_ENV. */
    const DEPLOYED = {
      WEB_BASE_URL: 'https://sambung.example',
      STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
    } satisfies NodeJS.ProcessEnv;

    it('refuses PAYMENT_GATEWAY=fake when a public origin is declared', () => {
      expect(() =>
        validateEnv({ ...DEPLOYED, PAYMENT_GATEWAY: 'fake' }),
      ).toThrow(/PAYMENT_GATEWAY must not be "fake"/);
    });

    it('refuses STORAGE_BOOTSTRAP=true when a public origin is declared', () => {
      expect(() =>
        validateEnv({ ...DEPLOYED, STORAGE_BOOTSTRAP: 'true' }),
      ).toThrow(/STORAGE_BOOTSTRAP must not be "true"/);
    });

    it('accepts an otherwise-correct deployment that forgot NODE_ENV', () => {
      expect(() => validateEnv(DEPLOYED)).not.toThrow();
    });

    // Newly reachable: today this boots and serves a broken <img> for every
    // photo, because the guard that would have caught it needed NODE_ENV.
    it('refuses a public site origin left with the dev photo origin', () => {
      expect(() =>
        validateEnv({
          WEB_BASE_URL: 'https://sambung.example',
          STORAGE_PUBLIC_BASE_URL:
            'http://sambung-photos.web.garage.localhost:3902',
        }),
      ).toThrow(/must be an https, non-loopback origin/);
    });

    // The shape the whole issue turns on: Garage on the VPS (architecture
    // §3.6), where a LOOPBACK STORAGE_ENDPOINT is the CORRECT production value
    // and PutBucketCors really succeeds against a publicly reachable bucket.
    it('covers the Garage-on-VPS shape (loopback STORAGE_ENDPOINT)', () => {
      expect(() =>
        validateEnv({
          WEB_BASE_URL: 'https://sambung.example',
          STORAGE_ENDPOINT: 'http://localhost:3900',
          STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
          STORAGE_BOOTSTRAP: 'true',
        }),
      ).toThrow(/STORAGE_BOOTSTRAP must not be "true"/);
    });

    it('derives it from STORAGE_PUBLIC_BASE_URL when WEB_BASE_URL is unset', () => {
      expect(() =>
        validateEnv({
          STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
        }),
      ).toThrow(/WEB_BASE_URL must be set/);
    });

    it('treats an env declaring no browser-facing origin as a deployment', () => {
      // Nothing proves this is a sandbox, so it is not given the benefit of the
      // doubt. (Near-unreachable: StorageService getOrThrow's
      // STORAGE_PUBLIC_BASE_URL, so a process with neither cannot boot anyway.)
      expect(() => validateEnv({ PAYMENT_GATEWAY: 'fake' })).toThrow(
        /no browser-facing origin is declared/,
      );
      expect(() => validateEnv({})).toThrow(/WEB_BASE_URL must be set/);
    });

    it('is not disabled by NODE_ENV=development', () => {
      // A copied .env carries its declared mode along; where the guests are
      // being sent is the stronger evidence, so the observable fact wins.
      expect(() =>
        validateEnv({
          ...DEPLOYED,
          NODE_ENV: 'development',
          PAYMENT_GATEWAY: 'fake',
        }),
      ).toThrow(/PAYMENT_GATEWAY must not be "fake"/);
    });

    it('names the evidence in the message, so a surprise refusal is debuggable', () => {
      expect(() =>
        validateEnv({ ...DEPLOYED, STORAGE_BOOTSTRAP: 'true' }),
      ).toThrow(
        /treated as a deployment because WEB_BASE_URL names the public origin https:\/\/sambung\.example/,
      );
    });

    // The inverted guard #193 warns against: a non-loopback STORAGE_ENDPOINT is
    // NOT evidence of a deployment (R2 from a laptop is ordinary), and a
    // loopback one is not evidence against one (Garage on the VPS). Only the
    // origins a guest's BROWSER is sent to carry the signal.
    it('ignores STORAGE_ENDPOINT entirely', () => {
      expect(() =>
        validateEnv({
          ...LOCAL,
          STORAGE_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
          STORAGE_BOOTSTRAP: 'true',
        }),
      ).not.toThrow();
    });

    it('lets a value that is not a URL declare nothing either way', () => {
      // A typo'd WEB_BASE_URL must not flip a developer's box into deployment
      // mode; the other declared origin still decides.
      expect(() =>
        validateEnv({
          ...LOCAL,
          WEB_BASE_URL: 'localhost:5173',
          STORAGE_BOOTSTRAP: 'true',
        }),
      ).not.toThrow();
    });
  });
});
