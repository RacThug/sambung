/**
 * One answer to "can the public internet reach this host?", for the two callers
 * that ask it from opposite directions:
 *
 * - `ical-fetcher` (ADR-0016) REFUSES to fetch a private host: the server makes
 *   that request on an owner's behalf, so a feed URL pointing at loopback or the
 *   cloud metadata address is SSRF.
 * - `deployment-env` (#193) treats a process whose browser-facing origins are
 *   all private as a local sandbox, and leaves the production guards off.
 *
 * They were two copies of the same list, and the #193 review is what made that
 * expensive: the copies disagreed about `192.168.1.20`, one calling it an
 * internal target and the other "the public origin", so the same address was
 * simultaneously too dangerous to fetch and proof of a live deployment. One
 * fact, one definition (the read-can't-disagree-with-write rule applied to a
 * predicate).
 *
 * WHAT COUNTS AS PRIVATE: loopback, the unspecified address, the RFC-1918
 * ranges, link-local (incl. the 169.254.169.254 metadata address), IPv6
 * unique-local, and the special-use names that cannot exist on the public
 * internet - `.localhost` (RFC 6761), `.local` (mDNS, RFC 6762), `.internal`
 * (ICANN-reserved for private use, and where Docker's `host.docker.internal`
 * lands) and `.home.arpa` (RFC 8375).
 *
 * IT MATCHES LITERALS, NOT RESOLUTION - a NAME that resolves to a private IP is
 * not caught. That limitation is documented for the SSRF caller (ADR-0016: DNS
 * rebinding needs connect-time IP checks), and it is worth being explicit that
 * the two callers fail in OPPOSITE directions on it, which is why the matching
 * is strict:
 *
 * - SSRF fails OPEN: an unrecognised host is fetched.
 * - deployment-env fails CLOSED: an unrecognised host reads as public, so the
 *   guards run.
 *
 * That asymmetry is why `127.0.0.1.evil.com` must NOT match. It is an
 * attacker-controlled NAME, and an unanchored `/^127\./` accepted it - which on
 * the deployment side would have turned every production guard, and the session
 * cookie's `Secure` flag, off (#193 review).
 */
export function isPrivateHost(hostname: string): boolean {
  // `url.hostname` keeps the BRACKETS on an IPv6 literal (`[::1]`) - measured,
  // and the SSRF guard's own comment claimed otherwise, so `[::1]` was being
  // fetched. Strip them once, here, for every caller.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;

  // Special-use names. Reserved so they cannot resolve on the public internet.
  if (
    host === 'localhost' ||
    PRIVATE_USE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return true;
  }

  // IPv6 literals. A colon is the discriminator: without it, a NAME beginning
  // "fd" (`fdsa.example`) would match the unique-local prefix test below.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true; // loopback / unspecified
    if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(host)) return true; // fc00::/7 unique local
    return false;
  }

  // IPv4 literals, ANCHORED as a whole dotted quad. `new URL` normalises the
  // shorthands before we ever see them (`127.1` and `0x7f.1` both arrive as
  // `127.0.0.1` - measured), so the strict form loses nothing and is what keeps
  // a name like `127.0.0.1.evil.com` out.
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!quad) return false;
  const [a, b] = [Number(quad[1]), Number(quad[2])];
  if (a === 0 || a === 10 || a === 127) return true; // unspecified / private / loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  return false;
}

const PRIVATE_USE_SUFFIXES = [
  '.localhost', // RFC 6761
  '.local', // mDNS, RFC 6762
  '.internal', // ICANN-reserved for private use (host.docker.internal)
  '.home.arpa', // RFC 8375
] as const;
