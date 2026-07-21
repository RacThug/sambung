/**
 * Boot-time env guard. Called from main.ts before the app is built so a
 * misconfigured prod refuses to start (fail-fast) rather than boot degraded -
 * the same boot seam as load-env and the TRUST_PROXY env-gate live on.
 *
 * The production invariants it enforces:
 *
 * 1. WEB_BASE_URL must be set. It is the TRUSTED public origin the OG stub's
 *    canonical `og:url` and the payment finish URL are built from (#127,
 *    ADR-0019). When it is unset those callers fall back to the inbound request
 *    origin - a client-settable `Host`, on `http` unless TRUST_PROXY is set - so
 *    a link-preview crawler could be pointed at a spoofed host.
 *
 * 2-3. The two storage settings whose mis-set is SILENT (#68, ADR-0029). Both
 *    exist because the Garage -> R2 cutover is "a single env swap by design",
 *    and a half-swapped env is the failure mode that swap invites. See below.
 *
 * All are PRODUCTION-ONLY: refuse to boot a prod that would misbehave, but leave
 * dev/test - and every suite - on the existing behaviour, unchanged.
 *
 * Why here and not ConfigModule's `validate` hook: that hook makes its return
 * value the HIGHEST-precedence config source, shadowing runtime `process.env`
 * reads (it breaks throttle.spec, which mutates a limit at runtime). A pure guard
 * at the boot seam validates without touching config resolution, and stays
 * unit-testable directly (main.ts passes process.env).
 */
export function validateEnv(env: NodeJS.ProcessEnv): void {
  const isProduction = env.NODE_ENV === 'production';
  if (!isProduction) return;

  const webBaseUrl = env.WEB_BASE_URL?.trim() ?? '';
  if (!webBaseUrl) {
    throw new Error(
      'WEB_BASE_URL must be set in production: it is the trusted public origin the ' +
        'OG canonical (og:url) and the payment finish URL are built from. Without it ' +
        'those fall back to the spoofable request Host (#127). Set WEB_BASE_URL to the ' +
        'public site base, e.g. https://sambung.example',
    );
  }

  // STORAGE_PUBLIC_BASE_URL is the origin a GUEST'S BROWSER loads photos from.
  // Left on the dev default it points at Garage on loopback, so every photo on
  // the live site renders as a broken image - and nothing anywhere reports it:
  // the API never fetches this URL, the upload still succeeds, the gallery row
  // still saves. It is the storage mis-set with no observable symptom on the
  // server, which is exactly what a boot guard is for.
  //
  // Deliberately NOT guarding STORAGE_ENDPOINT the same way: the documented
  // fallback if R2 is unacceptable is Garage ON THE VPS (architecture §3.6),
  // where `http://localhost:3900` is the CORRECT production endpoint. The
  // public base has no such exception - it is browser-facing, so it can never
  // be loopback, and on an https site a plain-http URL is blocked as mixed
  // content before it is even fetched.
  const publicBase = env.STORAGE_PUBLIC_BASE_URL?.trim() ?? '';
  if (publicBase) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(publicBase);
    } catch {
      throw new Error(
        `STORAGE_PUBLIC_BASE_URL is not a valid URL in production: "${publicBase}". ` +
          'It is the origin browsers load photos from, e.g. https://photos.sambung.example',
      );
    }
    if (parsed.protocol !== 'https:' || isLoopbackHost(parsed.hostname)) {
      throw new Error(
        `STORAGE_PUBLIC_BASE_URL must be an https, non-loopback origin in production: ` +
          `got "${publicBase}". This is the dev (Garage) default left in place - every photo ` +
          'on the live site would render broken, silently. Set it to the R2 bucket custom ' +
          'domain (or the https origin proxying Garage). See docs/r2-cutover.md',
      );
    }
  }

  // STORAGE_BOOTSTRAP is the dev-only convenience that applies bucket CORS and
  // website access on boot so a fresh `docker compose up` just works. R2
  // supports neither PutBucketCors nor PutBucketWebsite over the S3 API - CORS
  // is set in its dashboard or via wrangler - so in prod this call fails and
  // StorageModule logs a WARNING and carries on. The result is the worst shape
  // available: an operator who copied the dev env believes CORS was applied,
  // and finds out only when a real browser upload fails a preflight. Refuse.
  if (env.STORAGE_BOOTSTRAP?.trim() === 'true') {
    throw new Error(
      'STORAGE_BOOTSTRAP must not be "true" in production: it is the dev-only Garage ' +
        'path (bucket CORS + website access on boot), and R2 supports neither call over ' +
        'the S3 API - it would fail as a mere warning while CORS is left unconfigured. ' +
        'Unset it and configure CORS in the R2 dashboard. See docs/r2-cutover.md',
    );
  }
}

/** Loopback in any of its spellings, incl. IPv6 and the RFC-6761 .localhost TLD. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\./.test(host)
  );
}
