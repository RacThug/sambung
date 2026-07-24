/**
 * Storage preflight - the R2 cutover instrument (#68, ADR-0029).
 *
 *   pnpm --filter api storage:doctor
 *
 * Probes whatever bucket the current STORAGE_* env points at and reports which
 * of the photo pipeline's assumptions actually hold there. It exists because
 * the photo pipeline's guarantees are only partly ours: the 5 MB cap and the
 * content-type whitelist are enforced by SIGNED HEADERS, which means they hold
 * exactly as far as the storage backend chooses to honour them. Garage does;
 * Cloudflare documents content-type enforcement and says nothing at all about
 * content-length. That gap can only be closed by measurement.
 *
 * Why this is not `jest properties-photos` pointed at prod (which is what #68
 * originally prescribed):
 *
 *  - That suite REGISTERS TENANTS. Its beforeAll POSTs /api/auth/register
 *    twice, so it writes rows to whatever DATABASE_URL names, and only cleans
 *    up if it reaches afterAll. Pointing it at a live deploy to test a STORAGE
 *    concern risks the database.
 *  - It PUTs from Node, which has no same-origin policy - so it cannot fail on
 *    a missing CORS policy, the misconfiguration most likely to break uploads
 *    in a real browser while every server-side check stays green.
 *  - It never loads STORAGE_PUBLIC_BASE_URL, so it cannot catch the other
 *    silent killer: photos that store fine and render as broken images.
 *
 * This script boots no Nest app and touches no database. It drives the SAME
 * StorageService the API uses - not a re-implementation, which would only prove
 * things about itself.
 *
 * Objects it writes go under a random `<uuid>/<uuid>/` prefix: the exact key
 * shape the app produces (that is the point), but under a tenant id no database
 * knows, so the photo GC sweep - which lists only the prefixes of tenants it can
 * see (ADR-0017) - can never mistake them for orphans. They are deleted on the
 * way out, including after a failure.
 */
import './../src/load-env'; // must be first: STORAGE_* into process.env
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../src/storage/storage.service';

/** A real JFIF header - the app's PATCH verifies magic bytes, so must we. */
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01,
]);

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

/** Run a probe; an unexpected throw is a failure, never a crashed script. */
async function probe(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    record(name, 'fail', `threw: ${String(err)}`);
  }
}

type FetchOutcome =
  | { reached: true; res: Response }
  | { reached: false; error: string };

/**
 * `fetch` that reports a TRANSPORT failure instead of throwing it.
 *
 * This matters most for the public-URL probe: an unbound custom domain fails at
 * DNS, and a bucket that is not public may refuse the connection outright - so
 * the single likeliest form of that misconfiguration arrives as a thrown
 * `TypeError: fetch failed`, not as a 403. Letting it reach the generic probe
 * catch would report the one thing an operator cannot act on. `fetch`'s message
 * is deliberately uninformative, so the underlying `cause` is unwrapped too
 * (that is where `ENOTFOUND` / `ECONNREFUSED` actually lives).
 */
async function tryFetch(
  url: string,
  init?: RequestInit,
): Promise<FetchOutcome> {
  try {
    return { reached: true, res: await fetch(url, init) };
  } catch (err) {
    return { reached: false, error: describeFetchError(err) };
  }
}

/**
 * Dig the actionable code out of a failed `fetch`. Node reports every transport
 * failure as `TypeError: fetch failed`, hiding the reason on `cause` - and when
 * a host resolves to several addresses, `cause` is an `AggregateError` whose own
 * string form is just "AggregateError". `ECONNREFUSED` / `ENOTFOUND` is the
 * whole diagnosis here, so it is worth two unwraps to surface it.
 */
function describeFetchError(err: unknown): string {
  const cause = (err as { cause?: unknown }).cause;
  // `AggregateError.errors` is typed `any[]`, so narrow it before reading.
  const inner: unknown =
    cause instanceof AggregateError
      ? ((cause.errors as unknown[])[0] ?? cause)
      : cause;
  const code = (inner as { code?: string } | undefined)?.code;
  if (code) return code;
  if (inner instanceof Error) return inner.message;
  return err instanceof Error ? err.message : 'unknown transport failure';
}

/**
 * The browser origin that will PUT uploads: the public site in prod, the Vite
 * server in dev - both named by WEB_BASE_URL. No new env var; the cutover
 * already has to set WEB_BASE_URL for unrelated reasons (#127).
 *
 * WEB_ORIGIN remains as a fallback for a run that sets only it. It left
 * .env.example with #182, when the dev bucket policy stopped reading an origin -
 * this script is now its only reader, so the default below is what dev uses.
 */
function browserOrigin(env: NodeJS.ProcessEnv): string {
  const base = env.WEB_BASE_URL?.trim();
  if (base) {
    try {
      return new URL(base).origin;
    } catch {
      // fall through to WEB_ORIGIN - a malformed WEB_BASE_URL is main.ts's
      // problem to report, not this script's.
    }
  }
  return env.WEB_ORIGIN?.trim() || 'http://localhost:5173';
}

async function main(): Promise<number> {
  const env = process.env;
  const storage = new StorageService(new ConfigService(env));
  const origin = browserOrigin(env);

  console.log('\nStorage preflight (#68, ADR-0029)\n');
  console.log('  endpoint   ', env.STORAGE_ENDPOINT);
  console.log('  region     ', env.STORAGE_REGION);
  console.log('  bucket     ', env.STORAGE_BUCKET);
  console.log('  public base', env.STORAGE_PUBLIC_BASE_URL);
  console.log('  access key ', `${env.STORAGE_ACCESS_KEY_ID?.slice(0, 6)}...`);
  console.log('  browser origin (for CORS)', origin);

  // Keys written by this run. Recorded before each PUT is attempted, so even a
  // backend that accepts a PUT we expected it to reject is cleaned up.
  const written: string[] = [];
  const tenantId = randomUUID();
  const propertyId = randomUUID();
  const presign = (size: number) =>
    storage.presignPhotoUpload({
      tenantId,
      propertyId,
      contentType: 'image/jpeg',
      size,
    });

  console.log(
    `\n  scratch prefix ${storage.photoKeyPrefix(tenantId, propertyId)}`,
  );
  console.log('\nProbes:\n');

  try {
    // 1. Credentials, endpoint, region and bucket all resolve. Listing an
    //    empty random prefix is a bounded call that proves the connection
    //    without walking a bucket that may hold thousands of photos.
    await probe('reachable', async () => {
      const objects = await storage.listObjects(`${randomUUID()}/`);
      record(
        'reachable',
        objects.length === 0 ? 'pass' : 'fail',
        objects.length === 0
          ? 'credentials, endpoint and bucket resolve'
          : 'a random prefix returned objects - wrong bucket?',
      );
    });

    // 2. The happy path: a presigned PUT is accepted at all. What came back out
    //    is checked by probe 5, which reads the object over the PUBLIC url -
    //    one read that proves both halves rather than two that overlap.
    let uploadedKey: string | undefined;
    await probe('presigned PUT round-trip', async () => {
      const name = 'presigned PUT round-trip';
      const { uploadUrl, key } = await presign(JPEG_BYTES.length);
      written.push(key);
      const put = await tryFetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: JPEG_BYTES,
      });
      if (!put.reached) {
        record(name, 'fail', `could not reach the endpoint - ${put.error}`);
        return;
      }
      if (!put.res.ok) {
        record(
          name,
          'fail',
          `PUT returned ${put.res.status} ${put.res.statusText}. Everything below depends on this.`,
        );
        return;
      }
      uploadedKey = key;
      record(name, 'pass', `uploaded ${key}`);
    });

    // 3. Content-Type is a SIGNED header, so a client that presigns a jpeg and
    //    uploads something else must be refused by storage - the whitelist has
    //    to hold after presign time, not just at it. Cloudflare documents this
    //    for R2 ("uploads will fail with 403/SignatureDoesNotMatch"), so a
    //    failure here means something is wrong with the signing, not with R2.
    await probe('content-type is enforced', async () => {
      const name = 'content-type is enforced';
      const { uploadUrl, key } = await presign(4);
      written.push(key);
      const put = await tryFetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: Buffer.from('test'),
      });
      // A transport failure proves nothing either way - say so rather than
      // reading "the request did not complete" as "the backend refused it".
      if (!put.reached) {
        record(name, 'fail', `inconclusive - ${put.error}`);
        return;
      }
      record(
        name,
        put.res.ok ? 'fail' : 'pass',
        put.res.ok
          ? 'a jpeg presign accepted png bytes - the content-type whitelist does NOT hold at the storage layer'
          : `mismatched content-type refused (${put.res.status})`,
      );
    });

    // 4. Content-Length is also signed - this is what makes the 5 MB cap real
    //    rather than advisory. Garage enforces it. Cloudflare's R2 docs are
    //    SILENT on it, which is precisely why this is measured rather than
    //    assumed. A "not enforced" answer is a FINDING, not a blocker: the
    //    orphan-GC sweep evicts oversize objects independently of its grace
    //    window (#69, ADR-0017), so the cap degrades from "enforced at upload"
    //    to "enforced within a day" - and the threat is a tenant oversizing
    //    THEIR OWN gallery (quota), since presign is authenticated and
    //    tenant-scoped.
    await probe('content-length is enforced', async () => {
      const name = 'content-length is enforced';
      const { uploadUrl, key } = await presign(4);
      written.push(key);
      const put = await tryFetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: Buffer.from('way-more-than-four-bytes'),
      });
      if (!put.reached) {
        record(name, 'fail', `inconclusive - ${put.error}`);
        return;
      }
      record(
        name,
        put.res.ok ? 'finding' : 'pass',
        put.res.ok
          ? 'NOT enforced: a 4-byte presign accepted 24 bytes. The 5 MB cap now holds only at presign time; ' +
              'the daily oversize eviction (#69) is the backstop. Quota risk within a tenant, not a data risk.'
          : `oversized body refused (${put.res.status})`,
      );
    });

    // 5. STORAGE_PUBLIC_BASE_URL actually serves the object to an anonymous
    //    reader. This is the box "confirm a photo renders" - and it is the
    //    failure the application can never report, because a bad public base
    //    produces a broken <img> in a guest's browser and nothing anywhere
    //    else. No credentials are sent: that is the whole point.
    const NOT_PUBLIC =
      'Public access or the custom domain binding is not in place; photos will render broken.';
    await probe('public URL serves the object anonymously', async () => {
      const name = 'public URL serves the object anonymously';
      if (!uploadedKey) {
        record(name, 'fail', 'inconclusive - nothing was uploaded');
        return;
      }
      const url = storage.publicUrl(uploadedKey);
      const got = await tryFetch(url);
      // An unbound custom domain fails at DNS and a closed bucket may refuse
      // the connection, so "did not resolve" is the LIKELIEST shape of this
      // misconfiguration - it must read as the misconfiguration, not as a
      // stack trace.
      if (!got.reached) {
        record(
          name,
          'fail',
          `${url} could not be reached (${got.error}). ${NOT_PUBLIC}`,
        );
        return;
      }
      const type = got.res.headers.get('content-type') ?? '';
      if (!got.res.ok || !type.startsWith('image/')) {
        record(
          name,
          'fail',
          `${url} -> ${got.res.status} ${type || '(no content-type)'}. ${NOT_PUBLIC}`,
        );
        return;
      }
      // Byte-identical, not merely 200: this is the only read-back in the run,
      // so it is where a backend that silently truncates or re-encodes would
      // show up.
      const body = Buffer.from(await got.res.arrayBuffer());
      record(
        name,
        body.equals(JPEG_BYTES) ? 'pass' : 'fail',
        body.equals(JPEG_BYTES)
          ? `${url} -> ${got.res.status} ${type}, bytes identical`
          : `${url} -> ${got.res.status} ${type}, but ${body.length} bytes came back ` +
              `where ${JPEG_BYTES.length} went in - the object was altered in storage.`,
      );
    });

    // 6. CORS. The browser PUTs directly to the storage endpoint, so without a
    //    bucket CORS policy every upload dies in the browser on the preflight -
    //    while every server-side check above stays green, because Node has no
    //    same-origin policy. This is the one assumption the jest suite is
    //    structurally incapable of testing.
    await probe('CORS allows a browser PUT', async () => {
      const name = 'CORS allows a browser PUT';
      const { uploadUrl, key } = await presign(JPEG_BYTES.length);
      written.push(key); // nothing is stored by an OPTIONS, but be safe
      const got = await tryFetch(uploadUrl, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      if (!got.reached) {
        record(name, 'fail', `inconclusive - ${got.error}`);
        return;
      }
      const allowed = got.res.headers.get('access-control-allow-origin');
      // The verdict needs BOTH halves - the status AND the header - because
      // they can disagree. Garage attaches `access-control-allow-origin: *` to
      // its 403 REFUSALS, so reading the header alone reported a wrong-origin
      // policy, and a bucket with NO policy at all, as a wildcard PASS: three
      // states, one line (measured on the #182 review). A missing policy can
      // also arrive as an ABSENT header - the shape R2 produces before CORS is
      // configured. A wildcard on a 2xx IS a genuine pass (the browser will
      // proceed) but is reported as such: the origin allowlist is not narrowing
      // anything, which is worth seeing rather than reading as "my origin was
      // matched".
      const ok = got.res.ok && (allowed === origin || allowed === '*');
      record(
        name,
        ok ? 'pass' : 'fail',
        ok
          ? allowed === '*'
            ? `preflight from ${origin} allowed by a WILDCARD policy (any origin)`
            : `preflight from ${origin} allowed`
          : `preflight from ${origin} -> ${got.res.status}, ` +
              `access-control-allow-origin: ${allowed ?? '(absent)'}. ` +
              'Browser uploads will fail even though this script can PUT. Configure bucket CORS.',
      );
    });
  } finally {
    // Leave nothing behind, whatever happened above.
    if (written.length) {
      try {
        await storage.deleteObjects(written);
        console.log(`\n  cleaned up ${written.length} scratch object(s)`);
      } catch (err) {
        console.log(
          `\n  CLEANUP FAILED (${String(err)}) - remove these by hand:\n` +
            written.map((k) => `    ${k}`).join('\n'),
        );
      }
    }
  }

  const failed = checks.filter((c) => c.verdict === 'fail');
  const findings = checks.filter((c) => c.verdict === 'finding');
  console.log(
    `\n${checks.length - failed.length - findings.length} passed, ` +
      `${failed.length} failed, ${findings.length} finding(s).\n`,
  );
  if (findings.length) {
    console.log('Findings are measurements, not blockers - record them in');
    console.log('docs/r2-cutover.md so the next reader knows what was true.\n');
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    // `process.exitCode`, NOT `process.exit()`. Forcing exit while undici is
    // still tearing down a socket that failed mid-probe aborts the process on
    // a libuv assertion, which replaces the exit code an operator (or a deploy
    // script) reads with a meaningless one - observed on Windows exactly in
    // the failure case this script exists to report. Setting the code and
    // letting the loop drain keeps the verdict intact.
    process.exitCode = code;
  })
  .catch((err) => {
    // A throw out here means the config itself is unusable (a missing
    // STORAGE_* var), which getOrThrow already names precisely.
    console.error(`\nstorage-doctor could not start: ${String(err)}\n`);
    process.exitCode = 1;
  });
