import type { PropertyOgTags } from '@sambung/shared';

/**
 * Renders a property's Open Graph values (built by `buildPropertyOgTags` in
 * @sambung/shared) into a STATIC HTML document for link-preview crawlers
 * (architecture §6 tier 2, #87, ADR-0019). Hand-rolled, no template engine: this
 * is a fixed skeleton with a handful of escaped interpolations, the same way the
 * .ics export (`ical.ts`) hand-rolls its serializer.
 *
 * The crawler only reads the <meta> tags and leaves. The <meta http-equiv
 * refresh> + <a> exist for the rare HUMAN who reaches this URL directly (not via
 * Caddy's UA match): they bounce to the real page at `/p/:slug`. No loop - a
 * human is at `/api/.../og` when redirected away to `/p/:slug`, and a human never
 * matches the crawler UA that would send them back here.
 *
 * SECURITY. `title`/`description` are TENANT-AUTHORED (a property's name and
 * description), and `canonicalUrl`/`image` are built from request/config input.
 * Every interpolation lands inside a double-quoted attribute or element text, so
 * every one is HTML-escaped - otherwise a name like `"><script>...` would break
 * out of the attribute and inject script into a page we serve. escapeHtml
 * neutralises the five characters that matter in both contexts.
 */
export function renderPropertyOgHtml(input: {
  tags: PropertyOgTags;
  /** The human page this stub stands in for: `https://host/p/:slug`. */
  canonicalUrl: string;
}): string {
  const { title, description, image, twitterCard } = input.tags;
  const url = input.canonicalUrl;

  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const u = escapeHtml(url);
  const img = image ? escapeHtml(image) : undefined;

  const lines = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${u}">`,
    ...(img ? [`<meta property="og:image" content="${img}">`] : []),
    `<meta name="twitter:card" content="${escapeHtml(twitterCard)}">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    ...(img ? [`<meta name="twitter:image" content="${img}">`] : []),
    `<link rel="canonical" href="${u}">`,
    // A human who lands here is bounced to the real page.
    `<meta http-equiv="refresh" content="0; url=${u}">`,
    '</head>',
    '<body>',
    `<p>Redirecting to <a href="${u}">${t}</a>.</p>`,
    '</body>',
    '</html>',
  ];
  return lines.join('\n') + '\n';
}

/**
 * Escape the five characters that let text break out of HTML element content or
 * a double-quoted attribute value. `&` first, or it would double-escape the
 * entities the others introduce.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
