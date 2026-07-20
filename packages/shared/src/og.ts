/**
 * Open Graph / social-preview values for a public property (architecture §6, #87).
 *
 * ONE source of truth for what a link preview shows, shared by both renderers:
 *
 *   - `apps/web` (`property-meta.tsx`) turns these into JSX <meta> tags that
 *     React 19 hoists into <head>. That works for Googlebot, which runs JS.
 *   - `apps/api` (`property-og-html.ts`) turns the SAME values into a static HTML
 *     document served to link-preview crawlers (WhatsApp, facebookexternalhit,
 *     Twitterbot, Telegram, LINE), which fetch raw HTML and never run JS.
 *
 * The two renderers escape differently (JSX auto-escapes; the HTML string must
 * escape by hand), so the markup cannot be shared - but the VALUES can, and they
 * are exactly what would drift if each side computed its own. Deriving them here
 * once is why "the crawler and the SPA show the same card" is true by
 * construction rather than by two copies of a template staying in sync (#87 AC).
 *
 * `og:url` is deliberately NOT here: the canonical URL is caller-context (the SPA
 * reads `window.location`, the API builds it from the request host), not a fact
 * about the property. Each caller supplies its own.
 */
import type { PublicPropertyResponse } from "./public-property";

export interface PropertyOgTags {
  /** <title> + og:title + twitter:title. */
  title: string;
  /** <meta name=description> + og:description + twitter:description. */
  description: string;
  /** og:image + twitter:image. Absent when the property has no photo. */
  image?: string;
  /**
   * twitter:card. `summary_large_image` only when there IS an image - otherwise
   * the card reserves space for one and renders a broken frame.
   */
  twitterCard: "summary" | "summary_large_image";
}

/**
 * Derive the preview values from a property's PUBLIC projection. Takes only the
 * four fields it reads, so a test needs no full response and no unrelated field
 * (price, verified, units) can accidentally influence the card.
 */
export function buildPropertyOgTags(
  property: Pick<
    PublicPropertyResponse,
    "name" | "description" | "address" | "photos"
  >,
): PropertyOgTags {
  const title = `${property.name} - Book direct`;

  // The card's line: the owner's own words when they wrote any, the address as a
  // fallback. Never a template like "Book NAME now" - that reads as spam and
  // tells a guest nothing the title doesn't.
  const description =
    property.description?.trim() ||
    (property.address
      ? `Book ${property.name} directly - ${property.address}`
      : `Book ${property.name} directly.`);

  const image = property.photos[0]?.url;

  return {
    title,
    description,
    image,
    twitterCard: image ? "summary_large_image" : "summary",
  };
}
