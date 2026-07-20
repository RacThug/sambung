/**
 * Boot-time env guard. Called from main.ts before the app is built so a
 * misconfigured prod refuses to start (fail-fast) rather than boot degraded -
 * the same boot seam as load-env and the TRUST_PROXY env-gate live on.
 *
 * The one production invariant it enforces: WEB_BASE_URL must be set. It is the
 * TRUSTED public origin the OG stub's canonical `og:url` and the payment finish
 * URL are built from (#127, ADR-0019). When it is unset those callers fall back
 * to the inbound request origin - a client-settable `Host`, on `http` unless
 * TRUST_PROXY is set - so a link-preview crawler could be pointed at a spoofed
 * host. That fallback is fine for a dev or a direct local hit (no public base
 * exists there), so the guard is PRODUCTION-ONLY: refuse to boot a prod that
 * would emit a spoofable canonical, but leave dev/test - and every suite - on the
 * existing optional-with-fallback behaviour, unchanged.
 *
 * Why here and not ConfigModule's `validate` hook: that hook makes its return
 * value the HIGHEST-precedence config source, shadowing runtime `process.env`
 * reads (it breaks throttle.spec, which mutates a limit at runtime). A pure guard
 * at the boot seam validates without touching config resolution, and stays
 * unit-testable directly (main.ts passes process.env).
 */
export function validateEnv(env: NodeJS.ProcessEnv): void {
  const isProduction = env.NODE_ENV === 'production';
  const webBaseUrl = env.WEB_BASE_URL?.trim() ?? '';

  if (isProduction && !webBaseUrl) {
    throw new Error(
      'WEB_BASE_URL must be set in production: it is the trusted public origin the ' +
        'OG canonical (og:url) and the payment finish URL are built from. Without it ' +
        'those fall back to the spoofable request Host (#127). Set WEB_BASE_URL to the ' +
        'public site base, e.g. https://sambung.example',
    );
  }
}
