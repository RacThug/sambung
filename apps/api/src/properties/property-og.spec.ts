import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPropertyOgTags } from '@sambung/shared';
import { ogCanonicalUrl, renderPropertyOgHtml } from './property-og-html';

/**
 * The crawler OG stub (#87, ADR-0019), the parts testable without a database:
 * the pure HTML renderer, and the committed Caddy user-agent match.
 *
 * The route itself (RLS scope, archived→404, no cross-tenant leak) is exercised
 * over supertest in public-properties.spec.ts, beside the JSON page it reuses.
 */
describe('renderPropertyOgHtml', () => {
  const canonicalUrl = 'https://sambung.app/p/seminyak-beach-villa';

  it('renders the shared OG values as og:* meta tags', () => {
    const tags = buildPropertyOgTags({
      name: 'Seminyak Beach Villa',
      description: 'Steps from the beach.',
      address: null,
      photos: [{ url: 'https://cdn.test/hero.jpg' }],
    });
    const html = renderPropertyOgHtml({ tags, canonicalUrl });

    // AC (a): name, description, hero photo all present as OG tags.
    expect(html).toContain(
      '<meta property="og:title" content="Seminyak Beach Villa - Book direct">',
    );
    expect(html).toContain(
      '<meta property="og:description" content="Steps from the beach.">',
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://cdn.test/hero.jpg">',
    );
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image">',
    );
    // Canonical + a human bounce to the real page.
    expect(html).toContain(`<link rel="canonical" href="${canonicalUrl}">`);
    expect(html).toContain(
      `<meta http-equiv="refresh" content="0; url=${canonicalUrl}">`,
    );
  });

  it('omits the image tags and asks for a small card when there is no photo', () => {
    const tags = buildPropertyOgTags({
      name: 'No Photo Villa',
      description: 'A quiet stay.',
      address: null,
      photos: [],
    });
    const html = renderPropertyOgHtml({ tags, canonicalUrl });

    expect(html).not.toContain('og:image');
    expect(html).not.toContain('twitter:image');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });

  it('HTML-escapes a tenant-authored name so it cannot break out of the attribute', () => {
    // A malicious property name. Without escaping this closes the content
    // attribute and injects a <script> into a page WE serve.
    const tags = buildPropertyOgTags({
      name: '"><script>alert(1)</script>',
      description: 'x & y < z > w " end',
      address: null,
      photos: [],
    });
    const html = renderPropertyOgHtml({ tags, canonicalUrl });

    // The dangerous sequence never appears raw...
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('"><script>');
    // ...it is escaped instead.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
    // Ampersand and angle brackets in the description are escaped too.
    expect(html).toContain('x &amp; y &lt; z &gt; w &quot; end');
  });
});

/**
 * The canonical origin the OG stub advertises (#127). It must come from TRUSTED
 * CONFIG (`WEB_BASE_URL`), not the inbound request, so `og:url` points at the real
 * public https origin no matter what `Host`/proto a crawler (or an attacker)
 * sends. The request-derived origin survives only as a dev/direct-hit fallback.
 */
describe('ogCanonicalUrl', () => {
  it('uses the configured public base, ignoring the request origin', () => {
    const url = ogCanonicalUrl({
      configuredBase: 'https://sambung.app',
      // A spoofed/dev origin that must NOT leak into the canonical.
      requestOrigin: 'http://evil.example.com:1337',
      slug: 'seminyak-beach-villa',
    });
    expect(url).toBe('https://sambung.app/p/seminyak-beach-villa');
  });

  it('trims a trailing slash on the configured base (no // in the canonical)', () => {
    const url = ogCanonicalUrl({
      configuredBase: 'https://sambung.app/',
      requestOrigin: 'http://localhost:3000',
      slug: 'villa',
    });
    expect(url).toBe('https://sambung.app/p/villa');
  });

  it('falls back to the request origin only when no base is configured', () => {
    for (const base of [undefined, null, '', '   ']) {
      const url = ogCanonicalUrl({
        configuredBase: base,
        requestOrigin: 'http://localhost:3000',
        slug: 'villa',
      });
      expect([base, url]).toEqual([base, 'http://localhost:3000/p/villa']);
    }
  });
});

/**
 * AC (b)/(d): the crawler user-agent match must be NARROW - an explicit
 * allowlist of preview fetchers - and must NOT catch search engines that render
 * JS. Caddy is not run in tests, so the committed config is the artifact under
 * review; this asserts its narrowness so "narrow" is a checked fact, not a
 * promise in a code review.
 */
describe('deploy/Caddyfile crawler match', () => {
  const caddyfile = readFileSync(
    resolve(__dirname, '../../../../deploy/Caddyfile'),
    'utf8',
  );
  // The single header_regexp line that selects crawlers.
  const uaLine = caddyfile
    .split('\n')
    .find((l) => l.includes('header_regexp User-Agent'));

  // Compile the committed pattern the way Caddy's `header_regexp` would: the
  // `(?i)` flag JS can't take inline becomes the `i` flag, and Caddy matches the
  // pattern ANYWHERE in the header (a search, not a full match). This lets us run
  // REAL user agents through the exact committed regex.
  const uaRegex = (() => {
    if (!uaLine) return null;
    const pattern = uaLine
      .trim()
      .replace(/^header_regexp\s+User-Agent\s+/, '')
      .replace(/^\(\?i\)/, '');
    return new RegExp(pattern, 'i');
  })();

  it('matches the preview crawlers this product depends on', () => {
    expect(uaLine).toBeDefined();
    for (const bot of [
      'facebookexternalhit', // Facebook / WhatsApp link scraping
      'WhatsApp',
      'Twitterbot',
      'TelegramBot',
      'Slackbot',
      'Discordbot',
      'line-poker', // LINE's link-preview scraper (#127)
    ]) {
      expect(uaLine).toContain(bot);
    }
  });

  /**
   * AC #1 (#127): LINE's REAL link-preview scraper matches, but the LINE in-app
   * BROWSER (a human) and LINE's SEARCH crawler do not. The stub is only for
   * fetchers that read meta tags and leave - not for a person tapping a link
   * inside the LINE app, and not for a search engine (that would be cloaking).
   */
  it("matches LINE's link-preview scraper (facebookexternalhit;line-poker)", () => {
    expect(uaRegex).not.toBeNull();
    expect(uaRegex?.test('facebookexternalhit/1.1;line-poker/1.0')).toBe(true);
    // Even if LINE ever drops the facebook prefix, the explicit token still catches it.
    expect(uaRegex?.test('line-poker/1.0')).toBe(true);
  });

  it('does NOT match the LINE in-app browser (a human) or Linespider (search)', () => {
    // A person who taps a link inside the LINE app - `Line/<version>[/IAB]` - must
    // get the real SPA, never the bounce stub. The old bare `Line/` token caught
    // exactly this human (#127).
    const lineInAppAndroid =
      'Mozilla/5.0 (Linux; Android 11; Pixel 4 Build/RQ2A.210405.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/90.0.4430.210 Mobile Safari/537.36 Line/11.10.2/IAB';
    const lineInAppIos =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.20.4';
    // LINE's search crawler - renders like a search engine, so a stub = cloaking.
    const linespider =
      'Mozilla/5.0 (compatible; Linespider/1.1; +https://lin.ee/4dwXkTH)';
    for (const ua of [lineInAppAndroid, lineInAppIos, linespider]) {
      expect([ua, uaRegex?.test(ua)]).toEqual([ua, false]);
    }
  });

  it('does NOT match search engines that render JS (they must get the SPA)', () => {
    // Googlebot/Bingbot run the SPA's JS and see tier-1 tags already. Serving
    // them a stub instead would be cloaking and would drop them onto a bounce
    // page. The allowlist must never name them.
    expect(uaLine).not.toMatch(/googlebot/i);
    expect(uaLine).not.toMatch(/bingbot/i);
    expect(
      uaRegex?.test(
        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      ),
    ).toBe(false);
    // An ordinary human browser is never a crawler.
    expect(
      uaRegex?.test(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe(false);
  });

  it('is an explicit allowlist, not a broad bot/crawler/spider wildcard', () => {
    // A catch-all like /bot|crawler|spider/i would serve stubs to humans and to
    // Googlebot. The narrowness IS the safety property here.
    expect(uaLine).not.toMatch(/\|bot\||\(bot\)|crawler|spider/i);
    // And never the bare `Line/` token - it matched the LINE in-app browser (#127).
    expect(uaLine).not.toContain('Line/');
  });
});
