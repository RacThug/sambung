/**
 * Booking contract (FR-BOOK-1, api-spec §5.3) - the WRITE half of boss fights #1
 * and #2: the guest funnel's checkout. Shared by api (validates the body at the
 * boundary, frames the response) and web (the /p/:slug/book checkout form).
 *
 * The booking vocabulary (status/source) lives HERE, beside the endpoints that
 * use it - it was deleted from index.ts as M0 scaffolding that had drifted from
 * the pgEnum (api-spec §8.6). Each enum is pinned to its pgEnum by a test in
 * apps/api (the one workspace that may import both packages/db and
 * packages/shared); the web app must never import packages/db (invariant #1), so
 * the list is necessarily hand-copied and only a test keeps the copies honest.
 */
import { z } from "zod";
import {
  MAX_AVAILABILITY_NIGHTS,
  availabilityReasonSchema,
  countNights,
} from "./availability";
import { rupiahSchema } from "./money";

/** booking.status - pinned to the `booking_status` pgEnum by a test (§8.6). */
export const bookingStatusSchema = z.enum([
  "pending_payment",
  "confirmed",
  "cancelled",
  "expired",
]);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

/**
 * The two statuses that hold a Unit's calendar against everyone else - the
 * glossary's "Occupying" (CONTEXT.md), as one shared constant. This is the
 * single source of truth for that set, referenced by every place that must agree
 * on it: the availability read (scoped to exactly the statuses the
 * `booking_no_overlap` exclusion constraint's WHERE covers), the booking write's
 * in-transaction re-check, and the unified calendar's `?status=` filter (#49,
 * ADR-0010) - the calendar names these two so a Cancelled/expired booking, which
 * frees its nights, never draws a phantom bar.
 *
 * A subset of `bookingStatusSchema.options`, asserted by a test so the two can't
 * drift; the web app may import this (never `packages/db`, invariant #1).
 */
export const OCCUPYING_STATUSES = ["pending_payment", "confirmed"] as const;
export type OccupyingStatus = (typeof OCCUPYING_STATUSES)[number];

/** booking.source - pinned to the `booking_source` pgEnum by a test (§8.6). */
export const bookingSourceSchema = z.enum([
  "direct",
  "airbnb",
  "booking_com",
  "vrbo",
  "manual_block",
]);
export type BookingSource = z.infer<typeof bookingSourceSchema>;

/**
 * Why a booking write is refused, machine-readable (api-spec §5.3, AC #4). A
 * SUPERSET of the availability read's reasons: the read (a GET, #47) can only
 * ever report `overlap`/`min_stay`, while the write additionally refuses a party
 * over capacity (`max_guests`) and a Unit retired mid-session (`unavailable`).
 *
 * `unavailable` is an archived Unit, named for its guest-facing EFFECT - the
 * public wire never carries the owner's internal word "archived" (ADR-0008). The
 * client branches on it differently from `overlap`: a dead Unit sends the guest
 * back to search, not to "try other dates".
 *
 * Derived from the read's set (spread), so a future read reason flows in
 * automatically and the two vocabularies cannot silently diverge.
 *
 * `archived` is the OWNER-side twin of `unavailable` (#50, ADR-0011): the guest
 * wire hides the word "archived" behind `unavailable`, but the owner's own write
 * (`POST /bookings`) may name it plainly - the owner sees archived inventory as
 * history, so refusing their block/walk-in on it says exactly why.
 */
export const bookingRefusalReasonSchema = z.enum([
  ...availabilityReasonSchema.options,
  "max_guests",
  "unavailable",
  "archived",
]);
export type BookingRefusalReason = z.infer<typeof bookingRefusalReasonSchema>;

/**
 * A phone in strict **E.164** form: `+`, a country code, then digits - no spaces
 * or punctuation (e.g. `+6281234567890`). This is the GUEST funnel's phone (#54)
 * and the SERVER's correctness boundary for it.
 *
 * WhatsApp is the confirmation channel, and its `wa.me` deeplink only resolves an
 * unambiguous international number. A bare national number like `0812...` is
 * genuinely ambiguous - you can't know the country from the digits - which is why
 * it broke the link. The checkout form now captures the country and submits E.164
 * (client-side `libphonenumber-js` does the per-country parse + validate, which is
 * UX); this regex is the guarantee the server enforces (correctness), so a bare
 * national number is REJECTED here, never silently guessed at.
 *
 * `^\+[1-9]\d{7,14}$` = `+`, a non-zero leading country-code digit, then 7-14 more
 * (8-15 digits total, the E.164 range).
 */
export const e164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, {
    message: "must be an international phone number (E.164, e.g. +6281234567890)",
  });

/**
 * A lenient phone for the OWNER's walk-in record (#50): the owner types a contact
 * to dial by hand, not a `wa.me` target, so format is not load-bearing here.
 * Accepts a leading `+` and spaces/hyphens/dots/parens around 8-15 digits, and
 * stores what the owner typed. The GUEST funnel uses the strict `e164PhoneSchema`
 * instead - its number feeds the confirmation deeplink and must be unambiguous.
 */
const guestPhoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine(
    (v) => {
      if (!/^\+?[\d\s().-]+$/.test(v)) return false;
      const digits = v.replace(/\D/g, "").length;
      return digits >= 8 && digits <= 15;
    },
    { message: "must be a valid phone number" },
  );

/**
 * The checkout body: `POST /public/bookings` (no auth). `unitId` is in the BODY,
 * not the path - PublicScope.enterFromUnitId resolves the tenant from it. There
 * is NO price field: the server recomputes `totalPriceIdr` from the Unit, the
 * client quote is advisory (api-spec §5.3).
 *
 * Dates reuse the availability window semantics: real calendar dates (rejects
 * 2026-02-30), half-open, `from < to`, capped at MAX_AVAILABILITY_NIGHTS. The cap
 * doubles as the overflow guard the #47 review added - `base x nights` stays far
 * under MAX_SAFE_INTEGER - inherited here because the write prices through the
 * same `quoteTotalIdr`.
 */
export const createBookingRequestSchema = z
  .object({
    unitId: z.string().uuid(),
    checkIn: z.string().date(),
    checkOut: z.string().date(),
    guestName: z.string().trim().min(1).max(120),
    guestPhone: e164PhoneSchema,
    guestEmail: z.string().trim().toLowerCase().email().max(254).optional(),
    /**
     * Party size. The upper bound here is sanity only (a typo can't exceed
     * int4); the REAL ceiling is the Unit's `max_guests`, which depends on the
     * chosen Unit and so can only be enforced server-side (a 409 `max_guests`).
     */
    guestCount: z.number().int().min(1).max(64),
  })
  .refine((b) => b.checkIn < b.checkOut, {
    message: "checkIn must be before checkOut",
    path: ["checkOut"],
  })
  .refine((b) => countNights(b.checkIn, b.checkOut) <= MAX_AVAILABILITY_NIGHTS, {
    message: `stay must be at most ${MAX_AVAILABILITY_NIGHTS} nights`,
    path: ["checkOut"],
  });
export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>;

/**
 * The 201 response (api-spec §5.3). `status` is always `pending_payment` at
 * creation (typed to the enum for reuse downstream). `holdExpiresAt` is
 * server-authoritative - the DB clock stamped `now() + the hold TTL` - and drives
 * the checkout countdown. `totalPriceIdr` is the SERVER's price, not the client's.
 */
export const createBookingResponseSchema = z.object({
  bookingId: z.string().uuid(),
  status: bookingStatusSchema,
  holdExpiresAt: z.string(), // ISO-8601 UTC
  totalPriceIdr: rupiahSchema,
  nights: z.number().int().positive(),
});
export type CreateBookingResponse = z.infer<typeof createBookingResponseSchema>;

/**
 * The OWNER-side create body: `POST /bookings` (auth, api-spec §5.4, #50). Two
 * shapes discriminated on `source` - the owner is an authority, not a customer
 * (ADR-0011), so the write shares the guest funnel's overlap chokepoint but not
 * its guest-protection policy:
 *
 * - `manual_block` (a **Block**): just the Unit + dates. No guest, no price - it
 *   Occupies the calendar but sells nothing.
 * - `direct` (a **walk-in**): `guestName` is REQUIRED (AC #2); contact is optional
 *   (the booking is already confirmed, so there's no WhatsApp step to feed);
 *   `totalPriceIdr` is optional - omitted, the server computes `base x nights`;
 *   provided, it is the owner's offline / negotiated rate.
 *
 * `guestCount` carries no `max_guests` ceiling here (the server skips that check
 * for the owner) - the `.max(64)` is int-overflow sanity only, same as the public
 * body. Dates reuse the availability window semantics via a shared superRefine
 * (discriminatedUnion members must be plain objects, so the cross-field checks
 * live on the union, not each branch).
 */
const stayDatesShape = {
  unitId: z.string().uuid(),
  checkIn: z.string().date(),
  checkOut: z.string().date(),
};

const manualBlockBodySchema = z.object({
  source: z.literal("manual_block"),
  ...stayDatesShape,
});

const walkInBodySchema = z.object({
  source: z.literal("direct"),
  ...stayDatesShape,
  guestName: z.string().trim().min(1).max(120),
  guestPhone: guestPhoneSchema.optional(),
  guestEmail: z.string().trim().toLowerCase().email().max(254).optional(),
  guestCount: z.number().int().min(1).max(64).optional(),
  totalPriceIdr: rupiahSchema.optional(),
});

export const createOwnerBookingRequestSchema = z
  .discriminatedUnion("source", [manualBlockBodySchema, walkInBodySchema])
  .superRefine((b, ctx) => {
    if (!(b.checkIn < b.checkOut)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "checkIn must be before checkOut",
        path: ["checkOut"],
      });
    } else if (countNights(b.checkIn, b.checkOut) > MAX_AVAILABILITY_NIGHTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `stay must be at most ${MAX_AVAILABILITY_NIGHTS} nights`,
        path: ["checkOut"],
      });
    }
  });
export type CreateOwnerBookingRequest = z.infer<
  typeof createOwnerBookingRequestSchema
>;

/**
 * The 201 for an owner create. Always born `confirmed` with no hold. `totalPriceIdr`
 * is nullable: a Block carries none. `bookingId` lets the UI jump straight to the
 * new booking's detail (§5.7).
 */
export const createOwnerBookingResponseSchema = z.object({
  bookingId: z.string().uuid(),
  status: z.literal("confirmed"),
  source: bookingSourceSchema,
  checkIn: z.string().date(),
  checkOut: z.string().date(),
  totalPriceIdr: rupiahSchema.nullable(),
  nights: z.number().int().positive(),
});
export type CreateOwnerBookingResponse = z.infer<
  typeof createOwnerBookingResponseSchema
>;

/**
 * The 200 for `POST /bookings/:id/cancel` (api-spec §5.6, #50). `refund` is
 * `"manual"` when a paid payment exists (v1 has no refund API, so the owner
 * settles out-of-band), else `"none"`. At M2 there are no payments, so it is
 * always `"none"`; the field is wired now so M3 doesn't retrofit the shape.
 */
export const cancelBookingResponseSchema = z.object({
  status: z.literal("cancelled"),
  refund: z.enum(["none", "manual"]),
});
export type CancelBookingResponse = z.infer<typeof cancelBookingResponseSchema>;
