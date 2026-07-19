/**
 * The authed reservations read - `GET /bookings` (api-spec §5.5) - the READ that
 * feeds the owner's dashboard. THE one booking-read path, shared by the unified
 * calendar (#49) and the reservations list (#51), and consulted by the booking
 * detail drawer (#50); ADR-0010, "the Calendar is composed, not served".
 *
 * Owner-facing, so it is the mirror-image of the public availability read (#47):
 * that read CLIPS ranges to the window and strips everything but dates, because a
 * Visitor must not learn a neighbour's guest or an out-of-window date; this read
 * returns WHOLE rows, because the owner owns the ledger. Same overlap-window
 * filter, opposite disclosure rule - driven entirely by who is asking.
 *
 * Shared by api (validates the query, frames the rows) and web (the calendar +
 * reservations views consume `BookingRow`).
 */
import { z } from "zod";
import { bookingSourceSchema, bookingStatusSchema } from "./booking";
import { MAX_AVAILABILITY_NIGHTS, countNights } from "./availability";
import { rupiahSchema } from "./money";

/**
 * A query param that may be absent, single (`?status=confirmed`), or repeated
 * (`?status=pending_payment&status=confirmed`). Express/Nest hand us `undefined`,
 * a bare string, or an array respectively; this normalizes all three to an array
 * of the inner type. The calendar names the two occupying statuses this way
 * (`OCCUPYING_STATUSES`), which a single-valued filter could not express - the
 * §5.5 refinement ADR-0010 records.
 */
const repeatable = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
    z.array(inner),
  );

/**
 * Query params for `GET /bookings` (all optional, AND-ed). The window (`from`,
 * `to`) is half-open `[from, to)` with OVERLAP semantics - a stay straddling
 * either edge matches - and must be supplied as a pair or not at all: a lone
 * `from` is an ambiguous window, so it is a 400, not a silent half-filter. The
 * same 366-night cap as the availability read guards the range scan. `status`
 * and `source` are repeatable set-filters; the caller selects, the endpoint
 * stays a neutral "list bookings" (no status filter = every status, which a
 * reservations MANAGEMENT list wants - owners search for cancelled bookings too).
 */
export const listBookingsQuerySchema = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    propertyId: z.string().uuid().optional(),
    unitId: z.string().uuid().optional(),
    status: repeatable(bookingStatusSchema).optional(),
    source: repeatable(bookingSourceSchema).optional(),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: "from and to must be supplied together",
    path: ["to"],
  })
  .refine((q) => !(q.from && q.to) || q.from < q.to, {
    message: "from must be before to",
    path: ["to"],
  })
  .refine(
    (q) =>
      !(q.from && q.to) || countNights(q.from, q.to) <= MAX_AVAILABILITY_NIGHTS,
    {
      message: `window must be at most ${MAX_AVAILABILITY_NIGHTS} nights`,
      path: ["to"],
    },
  );
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;

/**
 * One booking as the owner's dashboard sees it (api-spec §5.5). The WHOLE stay -
 * real `checkIn`/`checkOut`, not window-clipped; the calendar clips the bar
 * visually and shows an off-edge "continues" affordance. Nullable fields carry
 * their absences honestly: a `manual_block` has no guest, only a
 * `pending_payment` hold has `holdExpiresAt`, an unpriced/imported row has no
 * total. `unitId` (not the whole Unit) is enough - the view joins it to the
 * `GET /units` list it already holds (ADR-0010, composed not served).
 */
export const bookingRowSchema = z.object({
  id: z.string().uuid(),
  unitId: z.string().uuid(),
  source: bookingSourceSchema,
  status: bookingStatusSchema,
  checkIn: z.string().date(),
  checkOut: z.string().date(),
  guestName: z.string().nullable(),
  guestCount: z.number().int().positive().nullable(),
  holdExpiresAt: z.string().nullable(), // ISO-8601 UTC, only for a live hold
  totalPriceIdr: rupiahSchema.nullable(),
});
export type BookingRow = z.infer<typeof bookingRowSchema>;

/**
 * One booking in FULL, for the detail view `GET /bookings/:id` (api-spec §5.7,
 * #50). A superset of the list row: it adds the guest's contact and the display
 * names the page needs, because the detail read is the one place the owner
 * inspects a single reservation whole. Owner disclosure - the opposite of the
 * public read's clip (ADR-0010). `guestPhone`/`guestEmail` are nullable (a Block
 * has no guest; a walk-in may omit contact). Payment fields join at M3.
 */
export const bookingDetailSchema = bookingRowSchema.extend({
  guestPhone: z.string().nullable(),
  guestEmail: z.string().nullable(),
  propertyId: z.string().uuid(),
  propertyName: z.string(),
  unitName: z.string(),
});
export type BookingDetail = z.infer<typeof bookingDetailSchema>;
