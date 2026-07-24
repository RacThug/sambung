/**
 * One answer to "is this process a deployment?", for every caller that needs it
 * (#193).
 *
 * It used to be `NODE_ENV === 'production'`, and NOTHING in this repo sets that:
 * `start:prod` is a bare `node dist/main`, there is no Dockerfile, no compose
 * service exports it. So every production guard in `validate-env.ts` - and the
 * `Secure` flag on the refresh cookie - was inert on a real deployment unless
 * the operator happened to remember one variable that has no other effect. A
 * foot-gun whose only symptom is silence is exactly what this codebase closes
 * structurally (ADR-0029's STORAGE_BOOTSTRAP guard, the PAYMENT_GATEWAY=fake
 * seam), so the switch itself must not rest on discipline.
 *
 * THE RULE: a process is treated as a deployment UNLESS it can prove it is a
 * local sandbox. The proof is the set of origins it declares that a GUEST'S
 * BROWSER is sent to - `WEB_BASE_URL` (the public site) and
 * `STORAGE_PUBLIC_BASE_URL` (where photos load from). If every one of them is
 * PRIVATE (`common/private-host.ts`), no stranger is being sent anywhere real
 * and this is a sandbox. If any names a publicly reachable host, or none is
 * declared at all, it is a deployment.
 *
 * PRIVATE, NOT MERELY NON-LOOPBACK, and the LAN case is why (#193 review).
 * Serving Vite on `http://192.168.1.20:5173` to open the funnel on a real phone
 * over wifi is routine on a mobile-first product, and reading that as a
 * deployment refused to boot the API outright. It is also simply untrue: a LAN
 * address is not the public internet, this repo ALREADY says so in the SSRF
 * guard (ADR-0016 refuses to fetch RFC-1918), and every harm these guards
 * prevent needs public reachability - a LAN box cannot receive a Midtrans
 * webhook, cannot take money, and is not visited by a link-preview crawler. So
 * the two readings had to agree, and only one of them was right.
 *
 * Why those two vars and nothing else:
 *
 * - They are browser-facing, so on a real deployment they CANNOT be private -
 *   a stranger's phone does not resolve `localhost`. That is the same reasoning
 *   `validate-env` already used to justify guarding `STORAGE_PUBLIC_BASE_URL`
 *   while leaving `STORAGE_ENDPOINT` alone; this reuses it as the switch.
 * - `STORAGE_PUBLIC_BASE_URL` is `getOrThrow` in `StorageService`, so every
 *   process that can boot at all declares at least one of them. The
 *   "declares nothing" branch below is therefore near-unreachable, and it fails
 *   closed anyway.
 * - `STORAGE_ENDPOINT` is deliberately NOT consulted, and the inversion is
 *   worth stating because it is the obvious guard to reach for: R2 in
 *   production is non-loopback but rejects `PutBucketCors` anyway, while the
 *   blessed Garage-on-VPS production shape (architecture §3.6) is LOOPBACK and
 *   is the one where that call really succeeds. Keying on it would protect the
 *   safe case and miss the dangerous one.
 *
 * `NODE_ENV=production` stays SUFFICIENT (docs/r2-cutover.md sets it, and it is
 * the conventional declaration) but is no longer NECESSARY. `NODE_ENV` naming
 * anything else does NOT exempt a process: a declared mode travels with a
 * copied `.env`, whereas where the guests are actually being sent does not.
 *
 * THE RESIDUE, stated rather than glossed: a deployment that declares only
 * private browser origins - a `.env.example` copied wholesale onto a VPS -
 * still looks local, because nothing distinguishes it from a laptop. What
 * changes is that it is no longer SILENT: that deployment serves a broken
 * `<img>` for every photo and sends payers back to `localhost`, on day one. The
 * guarantee is "either the guard fires, or the misconfiguration is loud".
 */

import { isPrivateHost } from './common/private-host';

/** Env vars naming an origin a guest's browser is sent to. */
const BROWSER_FACING_ORIGIN_VARS = [
  'WEB_BASE_URL',
  'STORAGE_PUBLIC_BASE_URL',
] as const;

/**
 * Why this process considers itself a deployment - a phrase for the error
 * message - or `null` when it proved it is a local sandbox.
 *
 * Returned as prose rather than a boolean so a surprising refusal says which
 * variable convinced it. A guard that fires for an unexplained reason is a
 * guard people disable.
 */
export function deploymentEvidence(env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV?.trim() === 'production') return 'NODE_ENV=production';

  const declared: { name: string; url: URL }[] = [];
  for (const name of BROWSER_FACING_ORIGIN_VARS) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const url = parseBrowserOrigin(raw);
    // A value that is not a browser origin declares nothing either way: a
    // typo'd WEB_BASE_URL must not flip a developer's box into deployment
    // mode, and the other declared origin still decides.
    if (url) declared.push({ name, url });
  }

  if (declared.length === 0) {
    return 'no browser-facing origin is declared, so nothing proves this is a local sandbox';
  }

  const reachable = declared.find(({ url }) => !isPrivateHost(url.hostname));
  return reachable
    ? `${reachable.name} names the public origin ${reachable.url.origin}`
    : null;
}

/**
 * The value as an http(s) origin, or undefined when it is not one.
 *
 * `new URL` alone is not the test: it ACCEPTS `localhost:5173` (scheme
 * `localhost:`, empty hostname), the exact shape of a WEB_BASE_URL typed
 * without a scheme - and an empty hostname is not private, so a naive parse
 * reads a developer's typo as a public origin. Require a real host and a
 * browser scheme.
 */
function parseBrowserOrigin(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.hostname ? url : undefined;
}

/** True unless this process proved it is a local sandbox. See above. */
export function isDeployment(env: NodeJS.ProcessEnv): boolean {
  return deploymentEvidence(env) !== null;
}
