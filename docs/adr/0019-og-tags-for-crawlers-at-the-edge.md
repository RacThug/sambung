# ADR-0019: Link-preview crawlers get real OG tags at the edge, from one shared helper

- **Date**: 2026-07-20
- **Status**: Accepted
- **Issue**: #87 (M5, SEO tier 2)
- **Builds on**: #46 (SEO tier 1), ADR-0003/0006 (public scope + archived→404)

## Context

#46 shipped SEO **tier 1** (architecture §6): correct per-property
`<title>`/`<meta>`/`og:*` tags, rendered by React 19's native head-hoisting. That
works for Googlebot, which renders JS. It does **nothing** for link-preview
crawlers - WhatsApp, `facebookexternalhit`, Twitterbot, Telegram, LINE - which
fetch raw HTML and never execute a line of JS. What they see is the SPA's static
`index.html`: the generic title "sambung", no name, no photo.

That is exactly where this product lives: #46's first line is "a guest opens a
shared link", and in Indonesia that link arrives on WhatsApp. The one crawler
class that matters most is the one tier 1 doesn't serve.

Architecture §6 originally described tier 2 as "Prerender / Puppeteer snapshot",
which made it look like a headless-Chrome step on a $5 VPS. But **social crawlers
only read meta tags - they never render.** So the real cost is a template, not a
browser.

## Decision

Three parts, one principle each.

1. **The edge decides who is a crawler.** `deploy/Caddyfile` matches a **narrow,
   explicit allowlist** of preview-crawler user agents on `/p/*` and proxies just
   those requests to `GET /public/properties/:slug/og`. Everyone else - humans,
   Googlebot - falls through to the SPA, unchanged. The allowlist deliberately
   excludes Googlebot/Bingbot: they render JS and already see tier-1 tags, and
   serving them a stub instead would be cloaking.

2. **The API renders a static OG stub, through the existing public read.**
   `PublicPropertiesService.getOgHtmlBySlug` calls the *same* `getBySlug` the JSON
   page uses - same `PublicScope.enterFromSlug` + RLS, same archived→404
   (ADR-0006), same `SlugParamPipe` malformed→404. It is **not** a second read
   path a crawler could use to see a property a Visitor cannot. The result is a
   fixed HTML skeleton with the `og:*` tags and a `<meta http-equiv="refresh">` +
   `<a>` bouncing any stray human to the real `/p/:slug`.

3. **The OG values live in one shared helper.** `buildPropertyOgTags` in
   `packages/shared` derives title/description/image/twitter-card from a
   property's public projection. Both renderers consume it: the SPA's
   `property-meta.tsx` turns it into JSX `<meta>` tags; the API's
   `property-og-html.ts` turns the **same values** into an escaped HTML document.

## Why

**The shared seam is the values, not the markup.** JSX auto-escapes; an HTML
string must be escaped by hand - so the two renderers *cannot* share a renderer.
But they must not disagree about what the card says, and the derivation logic
("owner's description, else the address, else a bare cue"; "large card only if
there's a photo") is exactly what would drift if copied. Putting an HTML-string
renderer in `packages/shared` was rejected: the frontend renders JSX, so that
renderer would never actually be shared. Deriving the *values* once is the
smallest thing that makes AC (c) - "one place, no drift" - true by construction.

**The UA match belongs at the edge, and narrow.** Caddy already fronts every
request; identifying a crawler is a routing decision, not application logic. The
allowlist is explicit named bots rather than a `/bot|crawler|spider/i` catch-all,
because a too-broad match serves stubs to humans (worse than the gap it closes)
and would cloak search engines. Narrowness is the safety property, so it is
machine-checked: `property-og.spec.ts` asserts the committed `Caddyfile` names
the crawlers that matter and never names Googlebot/Bingbot, even though Caddy
itself is not run in tests.

**Tenant-authored text is escaped because the stub is HTML we serve.** A property
name like `"><script>…` would break out of the `content="…"` attribute and inject
script into a page on our origin. `escapeHtml` neutralises the five characters
that matter in element text and double-quoted attributes; the slug is already
`SLUG_PATTERN`-validated by the pipe before it reaches a URL path.

## Consequences

- **A forwarded villa link now previews with its name, description, and hero
  photo** on WhatsApp/Facebook/Twitter/etc., while humans and Googlebot are
  entirely unaffected - they never match the allowlist.
- **The crawler card and the SPA page cannot drift**: both read
  `buildPropertyOgTags`. A change to the derivation changes both.
- **The stub inherits the public read's judgements for free**: an archived
  property 404s the crawler exactly as it 404s a Visitor; an unknown or malformed
  slug 404s before any lookup.
- **The `Caddyfile` is now committed config** (previously only described in
  architecture §7). It is not executed by tests; its one security-relevant line -
  the UA allowlist - is asserted narrow by a spec.
- **Not verified against the live Facebook/WhatsApp scrapers** here (they cache
  aggressively and need a public URL). That final check is a manual demo-time
  step, noted on the issue.
- **A per-crawler-UA browser could loop** the meta-refresh (stub → /p/:slug →
  stub). Pathological - no real browser sends `facebookexternalhit` - and the same
  trade every OG-stub setup makes.
