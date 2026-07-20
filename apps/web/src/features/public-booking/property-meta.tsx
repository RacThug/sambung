import { buildPropertyOgTags } from "@sambung/shared";
import type { PublicPropertyResponse } from "@sambung/shared";

/**
 * Per-property meta + Open Graph tags (architecture §6 tier 1, #46 AC).
 *
 * No react-helmet. React 19 hoists <title> and <meta> rendered anywhere in the
 * tree into <head> natively, so the dependency architecture §6 suggested is one
 * we simply don't take (it is also unmaintained upstream).
 *
 * The tag VALUES come from `buildPropertyOgTags` in @sambung/shared, NOT from
 * logic inlined here. The API's crawler stub (#87, tier 2) renders the same
 * helper into static HTML, so a link preview shows the same card whether it was
 * fetched by Googlebot (which runs this JS) or by WhatsApp (which never does).
 * One source; no drift.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH TIERS EXIST.
 *
 * These JSX tags work for Googlebot, which renders JS. They are invisible to
 * link-preview crawlers - WhatsApp, facebookexternalhit, Twitterbot, Telegram,
 * LINE - which fetch raw HTML and never execute a line of JS. That is the case
 * this product cares about most: #46's first line is "a guest opens a shared
 * link", and in Indonesia that link arrives on WhatsApp.
 *
 * Tier 2 (#87) closes it WITHOUT a headless browser, because social crawlers
 * only READ meta tags: Caddy matches their user agents on /p/* and proxies them
 * to `GET /public/properties/:slug/og`, which returns a static HTML document
 * carrying these same values; humans and Googlebot keep getting this SPA.
 * ---------------------------------------------------------------------------
 */
export function PropertyMeta({
  property,
}: {
  property: PublicPropertyResponse;
}) {
  const { title, description, image, twitterCard } =
    buildPropertyOgTags(property);

  // OG needs an absolute URL. The page URL is built from the live origin rather
  // than an env var, so a preview deep-links back to the host the guest actually
  // opened. (Photo URLs are already absolute - STORAGE_PUBLIC_BASE_URL.)
  const url =
    typeof window === "undefined"
      ? undefined
      : window.location.origin + window.location.pathname;

  return (
    <>
      <title>{title}</title>
      <meta name="description" content={description} />

      <meta property="og:type" content="website" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      {url && <meta property="og:url" content={url} />}
      {image && <meta property="og:image" content={image} />}

      <meta name="twitter:card" content={twitterCard} />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      {image && <meta name="twitter:image" content={image} />}
    </>
  );
}
