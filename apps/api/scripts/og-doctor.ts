/**
 * Edge preflight - the link-preview instrument (#60 AC 4, ADR-0035).
 *
 *   pnpm --filter api og:doctor [baseUrl] [slug]
 *   pnpm --filter api og:doctor https://xyz.trycloudflare.com seminyak-beach-villa
 *
 * Probes whatever ORIGIN it is pointed at and reports whether the SEO tier-2
 * chain (ADR-0019) actually holds there: does the reverse proxy hand a crawler
 * the OG stub, does a human still get the SPA, and is the card the crawler reads
 * one a stranger's phone could actually render.
 *
 * WHY THIS EXISTS. `deploy/Caddyfile` says of itself "NOT executed by any test",
 * and that is true: `property-og.spec.ts` asserts the crawler user-agent regex is
 * NARROW by reading the file as text, which is a real guard against the
 * regression that recurs (someone broadening the match) but proves nothing about
 * behaviour. Nothing has ever run the rewrite, the SPA fallback, or the
 * humans-get-the-app path. Committed, reviewed, and unexecuted is not the same as
 * verified - so this runs it and measures the answer.
 *
 * It also closes the gap that made #60 AC 4 undoable: "verify the card with a
 * real crawler" reads as "deploy first", but three of the four things that check
 * would catch are mechanical, and a crawler is a poor instrument for them - it
 * reports one blurry verdict, caches it hard, and tells you nothing about which
 * link broke. See docs/og-verification.md for the tunnel recipe that closes the
 * genuinely-manual fourth.
 *
 * DESIGN NOTES, both deliberate:
 *
 *  - It does NOT import `../src/load-env`, unlike storage-doctor. The target is
 *    an ARGUMENT, never app config - it has to be pointable at an origin that
 *    disagrees with what the app claims, or the forged-Host probe below is
 *    impossible to write. A config file this script can read is also not evidence
 *    about the process answering on a tunnel or a VPS.
 *  - It is strictly READ-ONLY. Only GETs, no database, no Nest app, no cleanup
 *    path to forget. That is the defect in #68's original prescription (point the
 *    photo suite at prod - a suite whose beforeAll registers tenants), and it is
 *    not repeated here.
 */
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { buildPropertyOgTags } from '@sambung/shared';
import type { PublicPropertyResponse } from '@sambung/shared';

/** A real link-preview crawler, as `deploy/Caddyfile` allowlists it. */
const UA_CRAWLER = 'facebookexternalhit/1.1';
/** LINE's link-preview scraper (#127). */
const UA_LINE_POKER = 'facebookexternalhit/1.1;line-poker/1.0';
/**
 * LINE's in-app BROWSER - a HUMAN holding a phone, not a scraper. The #127 fix
 * was to stop matching a bare `Line/`; this is the string that regression would
 * mis-serve, and until now it was only ever compared against the Caddyfile TEXT.
 */
const UA_LINE_IAB =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Mobile/15E148 Line/13.6.1/IAB';
/** Renders JS, must get the real SPA - serving it a stub would be cloaking. */
const UA_GOOGLEBOT =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

type Verdict = 'pass' | 'fail' | 'finding';

interface Check {
  name: string;
  verdict: Verdict;
  detail: string;
}

const checks: Check[] = [];
const record = (name: string, verdict: Verdict, detail: string): void => {
  checks.push({ name, verdict, detail });
  const mark = { pass: 'PASS', fail: 'FAIL', finding: 'NOTE' }[verdict];
  console.log(`  [${mark}] ${name} - ${detail}`);
};

/**
 * Run a probe; an unexpected throw is a failure, never a crashed script.
 *
 * Accepts a synchronous body too - not every question needs a round trip (whether
 * an image host is publicly resolvable is answered by parsing a URL), and forcing
 * those into `async` would be ceremony that hides which probes touch the network.
 */
async function probe(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    record(name, 'fail', `threw: ${String(err)}`);
  }
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

type Outcome =
  | { reached: true; res: RawResponse }
  | { reached: false; error: string };

/**
 * One GET, over `node:http`/`node:https` rather than `fetch`.
 *
 * MEASURED, not assumed: undici SILENTLY DROPS a `Host` header - it throws
 * nothing and sends the real authority, so a forged-Host probe written with
 * `fetch` would report "canonical held firm" against an origin that never saw
 * the forgery. That single vacuous pass is the whole reason this helper exists;
 * once it does, every edge probe uses it so they all send exactly the headers
 * they claim to.
 *
 * `Accept-Encoding` is deliberately unset: Caddy has `encode gzip`, and asking
 * for it would mean decompressing here to read the body for no gain.
 */
function request(
  url: string,
  headers: Record<string, string>,
): Promise<Outcome> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve({ reached: false, error: `not a valid URL: ${url}` });
      return;
    }
    const getter = target.protocol === 'https:' ? httpsGet : httpGet;
    const req = getter(target, { headers, timeout: 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({
          reached: true,
          res: {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          },
        }),
      );
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ reached: false, error: 'timed out after 10s' });
    });
    // A transport failure arrives here: ECONNREFUSED (nothing listening),
    // ENOTFOUND (an unbound tunnel host). That code IS the diagnosis, so it is
    // reported rather than a generic "request failed".
    req.on('error', (err: NodeJS.ErrnoException) =>
      resolve({ reached: false, error: err.code ?? err.message }),
    );
  });
}

/** GET the edge with a given user agent. */
const asUa = (base: string, path: string, ua: string): Promise<Outcome> =>
  request(base + path, { 'User-Agent': ua, Accept: '*/*' });

/**
 * What the response IS, decided by content rather than status - both the stub and
 * the SPA answer 200, so the status cannot tell them apart.
 *
 * The discriminator is exact and mutually exclusive: the OG stub is the ONLY
 * document in this system that carries server-rendered `og:` meta tags (the SPA's
 * are written by React at runtime, long after a crawler has read the bytes and
 * left), and the SPA shell is the only one with the React mount point.
 */
type Served = 'stub' | 'spa' | 'other';
function classify(body: string): Served {
  if (body.includes('property="og:title"')) return 'stub';
  if (body.includes('id="root"')) return 'spa';
  return 'other';
}

/** Pull one `content` value out of the stub's flat, hand-rolled markup. */
function meta(body: string, key: string): string | undefined {
  const attr = key.startsWith('og:') ? 'property' : 'name';
  const re = new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`);
  return re.exec(body)?.[1];
}

/** Undo `escapeHtml` from property-og-html.ts, to compare against raw values. */
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Is this a host only the machine running the probe can resolve?
 *
 * Deliberately a LOCAL copy of the idea in `ical-fetcher.ts`'s `isBlockedHost`,
 * not an import: that one is an SSRF guard whose narrowness is a security
 * property, and widening its export surface for a script's convenience is how a
 * guard acquires callers it was never reasoned about. The question here is also
 * different - not "may the server fetch this" but "can a crawler in Menlo Park".
 */
function isLocalOnlyHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) return false;
  const [a, b] = parts.map(Number);
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

async function main(): Promise<number> {
  const [rawBase = 'http://localhost', slug = 'seminyak-beach-villa'] =
    process.argv.slice(2);
  const base = rawBase.replace(/\/+$/, '');
  const probedOrigin = new URL(base).origin;
  const publicTarget = !isLocalOnlyHost(new URL(base).hostname);

  console.log(`\nog-doctor - probing ${base} for /p/${slug}\n`);

  // --- Preconditions -------------------------------------------------------
  //
  // Everything below reads a body, so a dead edge or an unbuilt SPA must be
  // named HERE. Otherwise it surfaces as a dozen mystery failures further down
  // and the operator debugs the wrong thing.
  const root = await asUa(base, '/', UA_BROWSER);
  if (!root.reached) {
    record(
      'edge reachable',
      'fail',
      `${root.error} - is the edge up? ` +
        '`docker compose --profile edge up -d` (see docs/og-verification.md)',
    );
    return 1;
  }
  if (classify(root.res.body) !== 'spa') {
    record(
      'edge reachable',
      'fail',
      `HTTP ${root.res.status} but the body is not the SPA shell. ` +
        'Most likely `apps/web/dist` is missing or stale - ' +
        'run `pnpm --filter @sambung/web build`.',
    );
    return 1;
  }
  record(
    'edge reachable',
    'pass',
    `HTTP ${root.res.status}, SPA shell served at /`,
  );

  // --- Routing: the code nothing has ever executed --------------------------
  const routes: {
    name: string;
    path: string;
    ua: string;
    want: Served;
    why: string;
  }[] = [
    {
      name: 'crawler gets the stub',
      path: `/p/${slug}`,
      ua: UA_CRAWLER,
      want: 'stub',
      why: 'the whole feature',
    },
    {
      name: 'human gets the SPA',
      path: `/p/${slug}`,
      ua: UA_BROWSER,
      want: 'spa',
      why: 'a too-broad match serves humans a redirect page',
    },
    {
      name: 'Googlebot gets the SPA',
      path: `/p/${slug}`,
      ua: UA_GOOGLEBOT,
      want: 'spa',
      why: 'serving a search crawler a stub is cloaking',
    },
    {
      name: 'LINE in-app browser gets the SPA',
      path: `/p/${slug}`,
      ua: UA_LINE_IAB,
      want: 'spa',
      why: 'the #127 regression: a bare `Line/` match hits humans',
    },
    {
      name: 'line-poker gets the stub',
      path: `/p/${slug}`,
      ua: UA_LINE_POKER,
      want: 'stub',
      why: "LINE's real preview scraper (#127)",
    },
    {
      name: 'trailing slash gets the stub',
      path: `/p/${slug}/`,
      ua: UA_CRAWLER,
      want: 'stub',
      why: 'the path regex allows an optional trailing slash',
    },
    {
      name: 'deeper path gets the SPA',
      path: `/p/${slug}/book`,
      ua: UA_CRAWLER,
      want: 'spa',
      why: 'the path regex is anchored - only the property page is rewritten',
    },
  ];
  for (const r of routes) {
    await probe(r.name, async () => {
      const got = await asUa(base, r.path, r.ua);
      if (!got.reached) {
        record(r.name, 'fail', `inconclusive - ${got.error}`);
        return;
      }
      const served = classify(got.res.body);
      record(
        r.name,
        served === r.want ? 'pass' : 'fail',
        served === r.want
          ? `${r.path} -> ${served} (${r.why})`
          : `${r.path} -> HTTP ${got.res.status}, served the ${served.toUpperCase()}, ` +
              `expected the ${r.want.toUpperCase()} - ${r.why}`,
      );
    });
  }

  await probe('unknown slug is a 404, not a stub', async () => {
    const got = await asUa(base, '/p/no-such-property-xyz', UA_CRAWLER);
    if (!got.reached) {
      record('unknown slug is a 404, not a stub', 'fail', got.error);
      return;
    }
    const leaked = classify(got.res.body) === 'stub';
    record(
      'unknown slug is a 404, not a stub',
      got.res.status === 404 && !leaked ? 'pass' : 'fail',
      got.res.status === 404 && !leaked
        ? 'HTTP 404, no card rendered'
        : `HTTP ${got.res.status}${leaked ? ', and it rendered a card' : ''} - ` +
            'an unknown or archived property must not preview (ADR-0006)',
    );
  });

  await probe('api still proxies', async () => {
    const got = await request(`${base}/api/public/properties/${slug}`, {
      Accept: 'application/json',
    });
    if (!got.reached) {
      record('api still proxies', 'fail', got.error);
      return;
    }
    record(
      'api still proxies',
      got.res.status === 200 ? 'pass' : 'fail',
      `GET /api/public/properties/${slug} -> HTTP ${got.res.status}`,
    );
  });

  // --- The card itself ------------------------------------------------------
  const stubGot = await asUa(base, `/p/${slug}`, UA_CRAWLER);
  const stub = stubGot.reached ? stubGot.res.body : '';
  const ogImage = meta(stub, 'og:image')
    ? unescapeHtml(meta(stub, 'og:image')!)
    : undefined;

  await probe('card matches the live page', async () => {
    const name = 'card matches the live page';
    if (!stub) {
      record(
        name,
        'fail',
        'no stub to compare - see the routing failure above',
      );
      return;
    }
    const json = await request(`${base}/api/public/properties/${slug}`, {
      Accept: 'application/json',
    });
    if (!json.reached || json.res.status !== 200) {
      record(name, 'fail', 'could not read the public property JSON');
      return;
    }
    // The SAME function the SPA's <meta> tags use. Comparing against a
    // re-implementation would only prove this script agrees with itself; ADR-0019
    // claims the crawler card and the rendered page CANNOT drift, and this is the
    // first thing that tests that claim over the wire rather than by shared code.
    const property = JSON.parse(json.res.body) as PublicPropertyResponse;
    const want = buildPropertyOgTags(property);
    const mismatches: string[] = (
      [
        ['og:title', want.title],
        ['og:description', want.description],
        ['twitter:card', want.twitterCard],
      ] as [string, string][]
    )
      .filter(
        ([key, expected]) => unescapeHtml(meta(stub, key) ?? '') !== expected,
      )
      .map(([key]) => key);
    // og:image is compared separately: it is absent from the markup entirely when
    // the property has no photo, so a `meta()` lookup cannot distinguish "no tag"
    // from "empty tag" the way the three above can.
    if (ogImage !== want.image) mismatches.push('og:image');
    record(
      name,
      mismatches.length === 0 ? 'pass' : 'fail',
      mismatches.length === 0
        ? `title/description/image/card identical to buildPropertyOgTags("${property.name}")`
        : `drifted from the live page: ${mismatches.join(', ')}`,
    );
  });

  await probe('og:image is fetchable', async () => {
    const name = 'og:image is fetchable';
    if (!ogImage) {
      // Not a failure: a property with no photo correctly renders a `summary`
      // card with no image. Worth SAYING, because "no image tag" and "a broken
      // image" look identical in a WhatsApp bubble.
      record(
        name,
        'finding',
        'the property has no photo - card will be text-only',
      );
      return;
    }
    const got = await request(ogImage, { Accept: 'image/*' });
    if (!got.reached) {
      record(name, 'fail', `${ogImage} -> ${got.error}`);
      return;
    }
    const type = String(got.res.headers['content-type'] ?? '');
    const ok = got.res.status === 200 && type.startsWith('image/');
    record(
      name,
      ok ? 'pass' : 'fail',
      ok
        ? `HTTP 200, ${type}, fetched anonymously`
        : `HTTP ${got.res.status}, content-type ${type || '(absent)'} - ` +
            'a crawler cannot render this image',
    );
  });

  await probe('og:image is reachable by a stranger', () => {
    const name = 'og:image is reachable by a stranger';
    if (!ogImage) {
      record(name, 'pass', 'no image to reach');
      return;
    }
    const host = new URL(ogImage).hostname;
    const local = isLocalOnlyHost(host);
    record(
      name,
      local ? 'finding' : 'pass',
      local
        ? `og:image points at ${host}, which only THIS machine resolves. ` +
            'The probe above passed because it ran here; a real crawler will ' +
            'render a text-only card. Point STORAGE_PUBLIC_BASE_URL at a public ' +
            'origin before the manual pass (docs/og-verification.md).'
        : `${host} is publicly resolvable`,
    );
  });

  await probe('og:image weight', async () => {
    const name = 'og:image weight';
    if (!ogImage) {
      record(name, 'pass', 'no image to weigh');
      return;
    }
    const got = await request(ogImage, { Accept: 'image/*' });
    if (!got.reached || got.res.status !== 200) {
      record(name, 'finding', 'could not weigh - see the fetch result above');
      return;
    }
    const bytes = Buffer.byteLength(got.res.body, 'utf8');
    const kb = Math.round(bytes / 1024);
    // A MEASUREMENT, never a verdict. Facebook documents a maximum (8 MB) and a
    // recommended 1200x630; the numbers people quote for WhatsApp's thumbnail
    // ceiling are folklore with no primary source, and folklore does not get to
    // fail an operator's run. Over Facebook's documented max IS a finding,
    // because that one is written down.
    record(
      name,
      bytes > 8 * 1024 * 1024 ? 'finding' : 'pass',
      bytes > 8 * 1024 * 1024
        ? `${kb} KB - over Facebook's documented 8 MB maximum`
        : `${kb} KB (Facebook's documented max is 8 MB; recommended 1200x630)`,
    );
  });

  // --- The canonical, and whether it can be moved by a stranger -------------
  await probe('og:url points at the probed origin', () => {
    const name = 'og:url points at the probed origin';
    const url = meta(stub, 'og:url');
    if (!url) {
      record(name, 'fail', 'the stub carries no og:url');
      return;
    }
    const origin = new URL(unescapeHtml(url)).origin;
    if (origin === probedOrigin) {
      record(name, 'pass', `${origin}`);
      return;
    }
    // Severity follows what the answer MEANS (ADR-0029's rule). Against a public
    // origin a wrong canonical is the #127 defect: a preview that points somewhere
    // else. Against localhost it is a dev artefact - Caddy serves :80 while
    // WEB_BASE_URL names the Vite server on :5173 - and failing on it every local
    // run is how a check teaches people to ignore it.
    record(
      name,
      publicTarget ? 'fail' : 'finding',
      `og:url is ${origin} but this probe is at ${probedOrigin}. ` +
        (publicTarget
          ? 'Crawlers will attribute the card to another origin. Set WEB_BASE_URL ' +
            'to the public origin and restart the API.'
          : 'Expected locally (WEB_BASE_URL names the Vite server). Set ' +
            `WEB_BASE_URL=${probedOrigin} to silence this.`),
    );
  });

  await probe('a forged Host cannot move og:url', async () => {
    const name = 'a forged Host cannot move og:url';
    const forged = 'evil.example';
    const got = await request(`${base}/p/${slug}`, {
      'User-Agent': UA_CRAWLER,
      Host: forged,
    });
    if (!got.reached) {
      record(name, 'fail', `inconclusive - ${got.error}`);
      return;
    }
    // Two shapes of pass, and they are genuinely different mechanisms. The edge
    // may refuse a foreign Host outright (a real deploy with a matched hostname
    // never reaches the site block); or it may serve, in which case og:url must
    // still come from trusted config and not from what the caller asserted.
    if (got.res.status === 404 || classify(got.res.body) !== 'stub') {
      record(
        name,
        'pass',
        `the edge refused Host: ${forged} (HTTP ${got.res.status}) - the stub is unreachable that way`,
      );
      return;
    }
    const url = meta(got.res.body, 'og:url');
    const moved = url?.includes(forged) ?? false;
    record(
      name,
      moved ? 'fail' : 'pass',
      moved
        ? `og:url became ${unescapeHtml(url!)} - WEB_BASE_URL is unset or ignored, so ` +
            'the canonical is caller-controlled (#127). A crawler can be pointed at a ' +
            'forged host by anyone who can send a request.'
        : `og:url held at ${unescapeHtml(url ?? '')} under Host: ${forged}`,
    );
  });

  const failed = checks.filter((c) => c.verdict === 'fail');
  const findings = checks.filter((c) => c.verdict === 'finding');
  console.log(
    `\n${checks.length - failed.length - findings.length} passed, ` +
      `${failed.length} failed, ${findings.length} finding(s).\n`,
  );
  if (findings.length) {
    console.log('Findings are measurements, not blockers - record them in');
    console.log(
      'docs/og-verification.md so the next reader knows what was true.\n',
    );
  }
  if (publicTarget && failed.length === 0) {
    console.log(
      'The mechanical chain holds on a public origin. The manual pass',
    );
    console.log('is now worth doing - paste these into the crawlers:\n');
    console.log(
      `  https://developers.facebook.com/tools/debug/?q=${base}/p/${slug}`,
    );
    console.log(`  ${base}/p/${slug}   (share into WhatsApp and LINE)\n`);
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    // `process.exitCode`, not `process.exit()` - forcing exit while a socket
    // from a failed probe is still tearing down replaces the verdict an operator
    // reads with a meaningless one (observed on Windows, storage-doctor #68).
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`\nog-doctor could not start: ${String(err)}\n`);
    process.exitCode = 1;
  });
