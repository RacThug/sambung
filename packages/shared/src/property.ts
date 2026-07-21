/**
 * Property contract (FR-PROP-1/3, api-spec §4.3-4.4). Shared by api (validates
 * input at the boundary, derives the badges) and web (form validation + the
 * live "Verified" badge preview on the edit page).
 */
import { z } from "zod";

/**
 * Optional text field, clearable via PATCH: absent = leave alone, null = clear.
 * Empty/whitespace strings normalize to null so a cleared form input and an
 * explicit null mean the same thing everywhere (and `verified` can't be
 * gamed with a blank license).
 */
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

/**
 * The Deposit percentage (ADR-0015, #52): share of a booking's total collected
 * online at checkout. 1-100 integer percent, default 100 (pay in full). Mirrored
 * by the `property_deposit_pct_range` DB CHECK. 0 is excluded on purpose - "pay
 * nothing to book" is not this pay-to-confirm funnel.
 */
export const DEFAULT_DEPOSIT_PCT = 100;
export const depositPctSchema = z.number().int().min(1).max(100);

/**
 * The Property's local clock (ADR-0028, #145). A CLOSED set of the three
 * Indonesian zones - WIB / WITA / WIT - mirrored by the `property_time_zone_known`
 * DB CHECK, not free IANA text: `AT TIME ZONE` is STABLE, not IMMUTABLE, so
 * Postgres cannot validate an arbitrary zone in a constraint, and a column whose
 * whole purpose is correctness should not be the one column with no DB backstop.
 * A typo'd `Asia/Makasar` would otherwise sit in the row and throw inside a cron.
 *
 * Listing a property outside Indonesia is a migration, deliberately: that is a
 * product-scope change, not a data-entry choice.
 *
 * What it is FOR: turning a UTC-stamped OTA calendar entry into the calendar date
 * a guest actually sleeps here (ical-parse.ts). Nothing else reads it - a stay is
 * stored as `date` columns and is timezone-free by construction (invariant #4).
 */
export const DEFAULT_PROPERTY_TIME_ZONE = "Asia/Makassar";
export const propertyTimeZoneSchema = z.enum([
  "Asia/Jakarta", // WIB, UTC+7 - Java, Sumatra
  "Asia/Makassar", // WITA, UTC+8 - Bali, Lombok, Sulawesi (the default)
  "Asia/Jayapura", // WIT, UTC+9 - Papua, Maluku
]);
export type PropertyTimeZone = z.infer<typeof propertyTimeZoneSchema>;

/**
 * The Deposit amount for a stay: `floor(total × pct / 100)` (ADR-0015). The
 * NUMBER-domain twin of the API's BigInt `depositAmountIdr` (apps/api payments),
 * so the web can preview what will be charged now. Exact - and equal to the
 * server's BigInt result - because a total (≤ the nightly-rate cap × 366 nights)
 * times 100 stays far under Number.MAX_SAFE_INTEGER, so the floor never loses a
 * rupiah. A test in apps/api pins the two implementations together.
 */
export function depositAmountIdr(totalIdr: number, pct: number): number {
  return Math.floor((totalIdr * pct) / 100);
}

export const createPropertyRequestSchema = z.object({
  name: z.string().trim().min(2).max(160),
  address: clearableText(400).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  description: clearableText(5000).optional(),
  /** NIB / KBLI 55193 - presence drives the "Verified" badge (FR-PROP-3). */
  licenseNo: clearableText(120).optional(),
  /** Deposit % (api #10). Optional at create; the DB defaults it to 100. */
  depositPct: depositPctSchema.optional(),
  /**
   * The Property's local clock (#145). Optional at create; the DB defaults it to
   * WITA (Bali). Like depositPct it IS in a request schema - a setting the owner
   * tunes, not a transition - and it is deliberately not mandatory: a required
   * select on the highest-abandonment screen in the product would be clicked
   * through just as fast as a default, for a field most owners never need.
   */
  timeZone: propertyTimeZoneSchema.optional(),
});
export type CreatePropertyRequest = z.infer<typeof createPropertyRequestSchema>;

/** PATCH body: every field optional; `name`, when present, cannot be null. */
export const updatePropertyRequestSchema = createPropertyRequestSchema.partial();
export type UpdatePropertyRequest = z.infer<typeof updatePropertyRequestSchema>;

export const propertyResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  /**
   * The public address (`/p/:slug`). Read-only: it is minted at create and
   * never moves, so it appears here and in NO request schema - a rename must
   * not break links already in the wild (ADR-0004). The owner sees it so the
   * edit page can show, and link to, the real public URL.
   */
  slug: z.string(),
  address: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  description: z.string().nullable(),
  licenseNo: z.string().nullable(),
  /**
   * Deposit % collected online at checkout (ADR-0015, #52). Always present -
   * the column is NOT NULL default 100 - so the edit page reads a real number,
   * never a blank that means "100".
   */
  depositPct: depositPctSchema,
  /**
   * The Property's local clock (ADR-0028, #145). Always present - the column is
   * NOT NULL default WITA - so the edit page reads a real zone, never a blank
   * that means Makassar. Owner-facing only: the PUBLIC payload does not carry it,
   * because the funnel has no use for it and a public surface stays as narrow as
   * it can be.
   */
  timeZone: propertyTimeZoneSchema,
  /** Gallery, in order: storage key + public URL per photo (#39). */
  photos: z.array(z.object({ key: z.string(), url: z.string() })),
  /** Derived: license present (FR-PROP-3). Never stored - see isVerified. */
  verified: z.boolean(),
  /** Derived: public page can render complete (FR-PROP-1 AC) - see isPublishable. */
  publishable: z.boolean(),
  /**
   * When this Property was archived (retired), or null if active (ADR-0005, #84).
   * Owner-facing only: the PUBLIC payload never carries it - an archived Property
   * simply 404s (ADR-0006). Read-only, set by POST /properties/:id/archive.
   */
  archivedAt: z.string().nullable(), // ISO-8601 UTC or null
  createdAt: z.string(), // ISO-8601 UTC
});
export type PropertyResponse = z.infer<typeof propertyResponseSchema>;

/** FR-PROP-3: the badge is presence of the NIB license - nothing else. */
export function isVerified(licenseNo: string | null | undefined): boolean {
  return typeof licenseNo === "string" && licenseNo.trim().length > 0;
}

/**
 * FR-PROP-1 AC / api-spec §4.3: publishable when the public page can render
 * "complete" - at least one photo AND at least one unit with a real price.
 * A zero-rupiah unit is a placeholder, not a sellable listing, so it does not
 * count as "priced".
 */
export function isPublishable(counts: {
  photoCount: number;
  pricedUnitCount: number;
}): boolean {
  return counts.photoCount >= 1 && counts.pricedUnitCount >= 1;
}
