import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPropertyOgTags } from '@sambung/shared';
import { renderPropertyOgHtml } from './property-og-html';

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

  it('matches the preview crawlers this product depends on', () => {
    expect(uaLine).toBeDefined();
    for (const bot of [
      'facebookexternalhit', // Facebook / WhatsApp link scraping
      'WhatsApp',
      'Twitterbot',
      'TelegramBot',
      'Slackbot',
      'Discordbot',
    ]) {
      expect(uaLine).toContain(bot);
    }
  });

  it('does NOT match search engines that render JS (they must get the SPA)', () => {
    // Googlebot/Bingbot run the SPA's JS and see tier-1 tags already. Serving
    // them a stub instead would be cloaking and would drop them onto a bounce
    // page. The allowlist must never name them.
    expect(uaLine).not.toMatch(/googlebot/i);
    expect(uaLine).not.toMatch(/bingbot/i);
  });

  it('is an explicit allowlist, not a broad bot/crawler/spider wildcard', () => {
    // A catch-all like /bot|crawler|spider/i would serve stubs to humans and to
    // Googlebot. The narrowness IS the safety property here.
    expect(uaLine).not.toMatch(/\|bot\||\(bot\)|crawler|spider/i);
  });
});
