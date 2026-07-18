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
 */
export const bookingRefusalReasonSchema = z.enum([
  ...availabilityReasonSchema.options,
  "max_guests",
  "unavailable",
]);
export type BookingRefusalReason = z.infer<typeof bookingRefusalReasonSchema>;

/**
 * A plausible international phone number. WhatsApp is the confirmation channel
 * (M3's wa.me deeplink), so this is REQUIRED for a direct booking. Deliberately
 * permissive: it accepts a leading `+` and spaces/hyphens/dots/parens around
 * 8-15 digits (the E.164 range) and stores what the guest typed. It does NOT
 * normalize to wa.me form - that is M3's job, where the link is built and the
 * exact target format is known. Validate presence and plausibility now; validate
 * shape when something actually dials it.
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
    guestPhone: guestPhoneSchema,
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
