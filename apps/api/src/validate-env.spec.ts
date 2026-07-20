import { validateEnv } from './validate-env';

/**
 * The boot-time config guard (#127 review follow-up). WEB_BASE_URL is the trusted
 * public origin the OG canonical and payment finish URL are built from; when it is
 * unset those fall back to the spoofable request Host. So it is REQUIRED in
 * production and OPTIONAL (fallback preserved) in dev/test. The guard is a pure
 * function of its env argument, so it is exercised directly with a fake env - the
 * shape main.ts hands it (process.env) - mirroring `mailer.factory.spec`.
 */
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
});
