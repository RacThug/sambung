import { deploymentEvidence, isDeployment } from './deployment-env';

/**
 * The one answer to "is this process a deployment?" (#193), now that
 * `NODE_ENV === 'production'` cannot be it (nothing in this repo sets that).
 * Two callers depend on it - the boot guards and the refresh cookie's `Secure`
 * flag - so it is pinned here against the shapes that actually exist, rather
 * than only through its consumers.
 *
 * A pure function of its env argument, so it is exercised directly with the
 * shape main.ts hands it (process.env), mirroring `validate-env.spec`.
 */

/** Every shape this repo, its docs and its runbooks actually produce. */
const SHAPES: {
  what: string;
  env: NodeJS.ProcessEnv;
  deployment: boolean;
}[] = [
  {
    what: 'dev: .env.example verbatim, no NODE_ENV',
    env: {
      WEB_BASE_URL: 'http://localhost:5173',
      STORAGE_ENDPOINT: 'http://localhost:3900',
      STORAGE_PUBLIC_BASE_URL:
        'http://sambung-photos.web.garage.localhost:3902',
      STORAGE_BOOTSTRAP: 'true',
    },
    deployment: false,
  },
  {
    what: 'e2e lane 2: ports offset, still loopback',
    env: {
      WEB_BASE_URL: 'http://localhost:5175',
      STORAGE_PUBLIC_BASE_URL:
        'http://sambung-photos.web.garage.localhost:3902',
      PAYMENT_GATEWAY: 'fake',
    },
    deployment: false,
  },
  {
    what: 'dev with the IPv6 / dotted-quad spellings of loopback',
    env: {
      WEB_BASE_URL: 'http://[::1]:5173',
      STORAGE_PUBLIC_BASE_URL: 'http://127.0.0.1:3902',
    },
    deployment: false,
  },
  {
    what: 'prod on R2, NODE_ENV declared (docs/r2-cutover.md)',
    env: {
      NODE_ENV: 'production',
      WEB_BASE_URL: 'https://sambung.example',
      STORAGE_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
      STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
    },
    deployment: true,
  },
  {
    what: 'prod on R2 that forgot NODE_ENV - the whole point of #193',
    env: {
      WEB_BASE_URL: 'https://sambung.example',
      STORAGE_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
      STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
    },
    deployment: true,
  },
  {
    // The blessed fallback (architecture §3.6): loopback STORAGE_ENDPOINT is
    // the CORRECT value here, and it is the one shape where PutBucketCors
    // really rewrites a live bucket. Keying on the endpoint would have read
    // this as dev.
    what: 'prod on Garage-on-VPS that forgot NODE_ENV (loopback endpoint)',
    env: {
      WEB_BASE_URL: 'https://sambung.example',
      STORAGE_ENDPOINT: 'http://localhost:3900',
      STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
    },
    deployment: true,
  },
  {
    what: 'half-swapped prod: public site, dev photo origin left behind',
    env: {
      WEB_BASE_URL: 'https://sambung.example',
      STORAGE_PUBLIC_BASE_URL:
        'http://sambung-photos.web.garage.localhost:3902',
    },
    deployment: true,
  },
  {
    // docs/og-verification.md §2 points both origins at Cloudflare quick
    // tunnels. The bucket really is publicly reachable then, so the guards
    // SHOULD fire - the runbook says to unset STORAGE_BOOTSTRAP for the pass.
    what: 'the og:doctor tunnel pass: local box, public origins',
    env: {
      WEB_BASE_URL: 'https://curious-otter.trycloudflare.com',
      STORAGE_ENDPOINT: 'http://localhost:3900',
      STORAGE_PUBLIC_BASE_URL: 'https://brave-panda.trycloudflare.com',
    },
    deployment: true,
  },
  {
    what: 'nothing declared: no proof of a sandbox, so fail closed',
    env: {},
    deployment: true,
  },
];

describe('isDeployment', () => {
  it.each(SHAPES)('$what -> deployment: $deployment', ({ env, deployment }) => {
    expect(isDeployment(env)).toBe(deployment);
  });

  it('is not exempted by a declared non-production NODE_ENV', () => {
    // A declared mode travels with a copied .env; where the guests are being
    // sent does not. The observable fact wins.
    const deployed = {
      WEB_BASE_URL: 'https://sambung.example',
      STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
    };
    expect(isDeployment({ ...deployed, NODE_ENV: 'development' })).toBe(true);
    expect(isDeployment({ ...deployed, NODE_ENV: 'test' })).toBe(true);
  });

  it('accepts NODE_ENV=production as sufficient on its own', () => {
    expect(
      isDeployment({
        NODE_ENV: 'production',
        WEB_BASE_URL: 'http://localhost:5173',
      }),
    ).toBe(true);
    // Trimmed, matching how validate-env compares its own values.
    expect(
      isDeployment({
        NODE_ENV: ' production ',
        WEB_BASE_URL: 'http://localhost:5173',
      }),
    ).toBe(true);
  });

  describe('a value that is not a browser origin declares nothing', () => {
    it.each([
      // `new URL` ACCEPTS this (scheme `localhost:`, empty hostname) - the
      // exact shape of a WEB_BASE_URL typed without a scheme. Read naively it
      // is "not loopback", i.e. a public origin, which would flip a
      // developer's box into deployment mode over a typo.
      'localhost:5173',
      'sambung.example',
      'not a url at all',
      'ftp://sambung.example',
      '   ',
    ])('%p', (value) => {
      expect(
        isDeployment({
          WEB_BASE_URL: value,
          STORAGE_PUBLIC_BASE_URL: 'http://localhost:3902',
        }),
      ).toBe(false);
    });

    it('still fails closed when it is the ONLY thing declared', () => {
      expect(isDeployment({ WEB_BASE_URL: 'localhost:5173' })).toBe(true);
    });
  });

  it('ignores STORAGE_ENDPOINT in both directions (the inverted guard)', () => {
    const local = {
      WEB_BASE_URL: 'http://localhost:5173',
      STORAGE_PUBLIC_BASE_URL: 'http://localhost:3902',
    };
    // A laptop pointed at a real R2 bucket is still a laptop...
    expect(
      isDeployment({
        ...local,
        STORAGE_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
      }),
    ).toBe(false);
    // ...and a VPS running Garage on loopback is still a deployment.
    expect(
      isDeployment({
        WEB_BASE_URL: 'https://sambung.example',
        STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
        STORAGE_ENDPOINT: 'http://localhost:3900',
      }),
    ).toBe(true);
  });
});

describe('deploymentEvidence', () => {
  it('names the variable and origin that convinced it', () => {
    expect(
      deploymentEvidence({
        WEB_BASE_URL: 'https://sambung.example',
        STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
      }),
    ).toBe('WEB_BASE_URL names the public origin https://sambung.example');

    expect(
      deploymentEvidence({
        WEB_BASE_URL: 'http://localhost:5173',
        STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
      }),
    ).toBe(
      'STORAGE_PUBLIC_BASE_URL names the public origin https://photos.sambung.example',
    );

    expect(deploymentEvidence({ NODE_ENV: 'production' })).toBe(
      'NODE_ENV=production',
    );
  });

  it('is null - no prose - on a proven local sandbox', () => {
    expect(
      deploymentEvidence({
        WEB_BASE_URL: 'http://localhost:5173',
        STORAGE_PUBLIC_BASE_URL: 'http://localhost:3902',
      }),
    ).toBeNull();
  });
});
