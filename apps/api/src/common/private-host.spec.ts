import { isPrivateHost } from './private-host';

/**
 * The one definition of "can the public internet reach this host?", shared by
 * the SSRF fetch guard (ADR-0016, refuses private) and the deployment switch
 * (#193, private = local sandbox). It gates a security path in both directions,
 * so it is pinned directly rather than only through its two callers.
 *
 * Hosts are given as they arrive from `new URL(...).hostname`, which is how both
 * callers obtain them - brackets on IPv6 and all.
 */

const PRIVATE = [
  // Loopback, every spelling. `new URL` normalises the IPv4 shorthands
  // (`127.1`, `0x7f.1`) to a dotted quad before a caller ever sees them.
  'localhost',
  'sambung-photos.web.garage.localhost',
  '127.0.0.1',
  '127.1.2.3',
  '[::1]',
  // Unspecified.
  '0.0.0.0',
  '[::]',
  // RFC-1918.
  '10.0.0.5',
  '172.16.0.9',
  '172.31.255.254',
  '192.168.1.20',
  // Link-local, incl. the cloud metadata address the SSRF guard exists for.
  '169.254.1.1',
  '169.254.169.254',
  '[fe80::1]',
  '[FE80::1]',
  // IPv6 unique local.
  '[fd00::1]',
  '[fc00::1]',
  // Special-use names that cannot exist on the public internet.
  'host.docker.internal',
  'nas.local',
  'printer.home.arpa',
];

const PUBLIC = [
  'sambung.example',
  'photos.sambung.example',
  'abc123.r2.cloudflarestorage.com',
  'curious-otter.trycloudflare.com',
  // THE one that matters: an attacker-controlled NAME merely prefixed with a
  // loopback literal. An unanchored /^127\./ accepted it, which on the
  // deployment side would have switched off every production guard and the
  // session cookie's Secure flag (#193 review).
  '127.0.0.1.evil.com',
  '127.0.0.1.nip.io',
  // Near-misses that must not be swept up by the IPv4 octet rules...
  '11.0.0.5.example.com',
  '1127.0.0.1',
  '172.32.0.1', // just outside 172.16/12
  '172.15.0.1', // just below it
  '192.169.1.1', // not 192.168/16
  '169.253.1.1', // not link-local
  // ...nor by the IPv6 prefix rules, which only apply to real IPv6 literals.
  'fdsa.example.com',
  'fe80.example.com',
  'local.example.com',
  'internal.example.com',
];

describe('isPrivateHost', () => {
  it.each(PRIVATE)('%s is private', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(PUBLIC)('%s is publicly reachable', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });

  it('reads a hostname straight off a URL, brackets and case included', () => {
    const priv = (u: string) => isPrivateHost(new URL(u).hostname);
    expect(priv('https://[::1]/x.ics')).toBe(true);
    expect(priv('http://127.1/')).toBe(true); // normalised to 127.0.0.1
    expect(priv('http://0x7f.1/')).toBe(true); // ditto
    expect(priv('https://LOCALHOST/x')).toBe(true);
    expect(priv('https://airbnb.com/x.ics')).toBe(false);
  });

  it('is not fooled by an empty host', () => {
    expect(isPrivateHost('')).toBe(false);
  });
});
