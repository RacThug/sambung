import type { PublicPropertyResponse } from "@sambung/shared";

/**
 * Per-property meta + Open Graph tags (architecture §6 tier 1, #46 AC).
 *
 * No react-helmet. React 19 hoists <title> and <meta> rendered anywhere in the
 * tree into <head> natively, so the dependency architecture §6 suggested is one
 * we simply don't take (it is also unmaintained upstream).
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING THESE TAGS.
 *
 * They work for Googlebot, which renders JS. They do NOT work for link-preview
 * crawlers - WhatsApp, facebookexternalhit, Twitterbot, Telegram, LINE. Those
 * fetch raw HTML and never execute a line of JS, so what they see is the SPA's
 * static index.html: the title "Sambung" and no image.
 *
 * That is precisely the case this product cares about most. #46's first line is
 * "a guest opens a shared link", and in Indonesia that link arrives on WhatsApp.
 * So this file satisfies the acceptance criterion while delivering little of
 * what the criterion is FOR. It is tier 1 as specced, and tier 1 is not enough.
 *
 * The fix is cheaper than architecture §6 assumes: §6 imagines Puppeteer, but
 * social crawlers only READ meta tags - they never render - so Caddy can match
 * their user agents and proxy to a small API route returning a static OG stub,
 * with humans and Googlebot still getting the real SPA. Tracked as a follow-up.
 * ---------------------------------------------------------------------------
 */
export function PropertyMeta({
  property,
}: {
  property: PublicPropertyResponse;
}) {
  const title = `${property.name} - Book direct`;
  // The description a preview card shows: the owner's own words when they wrote
  // any, the address as a fallback. Never a template like "Book NAME now" -
  // that reads as spam and tells a guest nothing they can't see in the title.
  const description =
    property.description?.trim() ||
    (property.address
      ? `Book ${property.name} directly - ${property.address}`
      : `Book ${property.name} directly.`);

  // OG needs absolute URLs. Photo URLs already are (STORAGE_PUBLIC_BASE_URL);
  // the page URL is built from the live origin rather than an env var, so a
  // preview deep-links back to the host the guest actually opened.
  const image = property.photos[0]?.url;
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

      {/* summary_large_image only if there IS an image - otherwise the card
          reserves space for one and renders a broken frame. */}
      <meta
        name="twitter:card"
        content={image ? "summary_large_image" : "summary"}
      />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      {image && <meta name="twitter:image" content={image} />}
    </>
  );
}
