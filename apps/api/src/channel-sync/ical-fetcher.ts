import { Injectable, Logger } from '@nestjs/common';

/**
 * The outbound iCal boundary (api-spec §7.1 smoke test, §8.5 testing seam).
 * Everything the app knows about reaching an OTA's feed is this interface; the
 * real `fetch` lives behind it in one adapter, and tests bind a fake so no suite
 * ever hits the network.
 *
 * A port, not an env-flag stub - the same shape as PAYMENT_GATEWAY (ADR-0015):
 * the test module swaps this token, so there is no second code path that could
 * ship to prod. Injected by this symbol because an interface has no runtime
 * identity to inject by.
 */
export const ICAL_FETCHER = Symbol('ICAL_FETCHER');

/**
 * The outcome of a smoke fetch. Deliberately NOT throw-on-failure: a feed being
 * unreachable is an EXPECTED result of a smoke test (the whole point is to find
 * out), and it must NOT fail the connect request - the connection is still
 * created, just with `last_status = 'error'` so the owner can see and fix it
 * (FR-SYNC-3). `ok=false` carries a human `error` for `last_error`; the fetched
 * BODY is never returned - only whether it looked like a calendar - so this port
 * cannot become a way to read an arbitrary URL's contents through the server.
 */
export interface IcalProbeResult {
  ok: boolean;
  error: string | null;
}

export interface IcalFetcher {
  /**
   * Fetch `url` once and report whether it is a reachable iCalendar feed. Never
   * throws for a network/HTTP/format failure - those are `{ ok: false }` results.
   */
  probe(url: string): Promise<IcalProbeResult>;
}

// A hung OTA must not pin a pooled connection: connect awaits this probe, so
// bound the fetch the way the Snap call is bounded (midtrans.gateway).
const PROBE_TIMEOUT_MS = 8_000;
// Read enough to recognise an iCalendar without slurping a huge feed: the header
// is at the very top, and this is a smoke test, not the importer.
const MAX_SNIFF_BYTES = 64 * 1024;
// A real OTA feed rarely redirects more than once or twice (http→https, a CDN
// hop). Cap it so a redirect loop can't spin, and follow each hop MANUALLY.
const MAX_REDIRECTS = 5;
// The 3xx codes fetch would auto-follow; we intercept them to re-validate the
// target host before making the next request.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The real adapter: an https GET over `fetch`, no library.
 *
 * "Reachable iCal feed" means: a 2xx response whose body begins with a
 * `BEGIN:VCALENDAR` header. Catching the common mistake (an owner pasting the OTA
 * webpage URL instead of the .ics export) is worth the extra check - it turns a
 * silent future import failure into an immediate, legible `error` status.
 *
 * SSRF: the server makes this request on the owner's behalf, so a private /
 * loopback host is refused - AND redirects are followed MANUALLY, re-checking the
 * block on every hop. `redirect: 'follow'` would validate only the first URL and
 * then let a public host `302` to `http://169.254.169.254/…` or the Postgres /
 * Garage host, which the pool would silently follow: the guard has to hold across
 * hops, not just at the door. Even so it only ever leaks a boolean (reachable +
 * looks-like-a-calendar, never the body). Not exhaustive - it blocks host
 * LITERALS, not a hostname that resolves to a private IP (DNS rebinding); a
 * per-connection token plus connect-time IP checks / a full egress allowlist are
 * the documented hardening path (ADR-0016).
 */
@Injectable()
export class HttpIcalFetcher implements IcalFetcher {
  private readonly logger = new Logger(HttpIcalFetcher.name);

  async probe(url: string): Promise<IcalProbeResult> {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      return { ok: false, error: 'Not a valid URL' };
    }

    // Follow redirects by hand so the https + private-host checks below run on
    // EVERY hop, not just the initial URL (the SSRF fix - see the class doc).
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.protocol !== 'https:') {
        return { ok: false, error: 'Feed URL must be https' };
      }
      if (isBlockedHost(current.hostname)) {
        return { ok: false, error: 'Feed host is not allowed' };
      }

      let res: Response;
      try {
        res = await fetch(current, {
          method: 'GET',
          // Do NOT auto-follow: we re-validate each hop's target ourselves.
          redirect: 'manual',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' },
        });
      } catch (cause) {
        // DNS / connection failure OR the timeout abort. Not our bug and not the
        // owner's request failing - just a feed we could not reach right now.
        this.logger.warn(
          `iCal probe unreachable for ${current.host}: ${String(cause)}`,
        );
        return { ok: false, error: 'Feed is unreachable' };
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        if (!location) {
          // A 3xx we cannot follow safely (no Location, or an opaque-redirect
          // response on a runtime that hides it). Fail closed rather than guess.
          return { ok: false, error: 'Feed redirect could not be verified' };
        }
        let next: URL;
        try {
          next = new URL(location, current); // resolves relative redirects
        } catch {
          return { ok: false, error: 'Feed redirect is invalid' };
        }
        current = next; // re-validated at the top of the next iteration
        continue;
      }

      if (!res.ok) {
        return { ok: false, error: `Feed responded ${res.status}` };
      }

      const head = await readHead(res).catch(() => '');
      if (!head.includes('BEGIN:VCALENDAR')) {
        return { ok: false, error: 'Response is not an iCalendar feed' };
      }
      return { ok: true, error: null };
    }

    return { ok: false, error: 'Too many redirects' };
  }
}

/** Read up to MAX_SNIFF_BYTES of the body as text, then stop - we only need the
 * header. Falls back to `res.text()` when the body isn't a readable stream. */
async function readHead(res: Response): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= MAX_SNIFF_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

/**
 * Block obvious internal targets. Covers loopback, link-local (incl. the cloud
 * metadata address 169.254.169.254), and the RFC-1918 private ranges as host
 * LITERALS. A hostname that resolves to a private IP at fetch time slips past
 * this - closing that needs DNS resolution + connect-time IP checks, out of scope
 * for v1 (ADR-0016).
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // IPv6 loopback / unspecified (URL keeps the brackets off hostname).
  if (host === '::1' || host === '::') return true;
  // IPv4 literals only - a name like `airbnb.com` has non-numeric labels.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 0 || a === 10) return true; // loopback / this-host / private
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  return false;
}
