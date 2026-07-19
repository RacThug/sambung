/**
 * Conflict (409) contract (api-spec §8.2, #82) - ONE convention for every 409.
 *
 * A 409 says "the request is well-formed but the world won't allow it": a taken
 * email, a duplicate unit name, an overlapping stay, an inventory row with
 * history, a booking already terminal. Whichever layer refuses - an app-level
 * pre-check, an FSM-guarded UPDATE, or a database constraint mapped by the
 * interceptor (#80) - the body carries a stable machine-readable `code` slug, and
 * the client switches on THAT, never on prose.
 *
 * Why a slug and not the server's sentence:
 * - **i18n (M5).** Server prose can't be translated in the browser; a slug + its
 *   typed detail lets the SPA compose localized copy. The web owns ALL user-facing
 *   copy for these cases - the API sends identity + data, never a rendered string.
 * - **Drift.** This enum is the single source of truth for the slug set, imported
 *   by both the API (which builds the bodies) and the web (which reads them), so
 *   renaming a slug is a compile error on both sides rather than a silent split -
 *   the exact failure mode the `booking_source` enum drift (§8.6) taught us to kill.
 *
 * Shape decision (ADR-0012): the slug lives in a dedicated `code` field, NOT in
 * `message`. `message` stays a human default for logs/observability; typed detail
 * (a delete guard's `count`, a refusal's `reasons`, an FSM's terminal `status`)
 * rides in sibling fields. `code` = which conflict; the siblings = its specifics.
 */
import { z } from "zod";
import { bookingRefusalReasonSchema, bookingStatusSchema } from "./booking";

/**
 * The closed set of 409 slugs. Every `ConflictException` the API throws sets one
 * of these in `code`. Add a member here and the discriminated union below forces
 * you to say what detail (if any) it carries - and the web's copy map (a `switch`
 * over `ConflictBody`) stops compiling until it handles the new case.
 */
export const conflictCodeSchema = z.enum([
  // auth: app_user.email is citext UNIQUE (the pre-check and the constraint both
  // arrive here - api-spec §5.3, indistinguishable to a client).
  "email_taken",
  // units: unit.(property_id, name) is UNIQUE (ADR-0001).
  "unit_name_taken",
  // delete guards (ADR-0002): the row has booking history, so deleting it would
  // destroy the ledger. Carries the count as data. Property and unit are distinct
  // slugs so the web renders the right noun without guessing from context.
  "property_has_bookings",
  "unit_has_bookings",
  // the booking write chokepoint (boss fight #1): these dates can't be taken.
  // Carries the machine-readable `reasons` (overlap / min_stay / max_guests /
  // unavailable / archived).
  "dates_unavailable",
  // the cancel FSM (#50): the booking is already terminal. Carries the terminal
  // `status` (cancelled / expired).
  "booking_not_cancellable",
  // the pay chokepoint (#52, ADR-0015): the booking can't be paid because it is
  // no longer a live hold - already confirmed/cancelled/expired, or its hold
  // lapsed (swept to `expired` before the check). Carries the blocking `status`.
  "booking_not_payable",
]);
export type ConflictCode = z.infer<typeof conflictCodeSchema>;

/**
 * The per-code body shapes. Each is `{ code } (+ typed detail)`; the union is
 * discriminated on `code`, so parsing a wire body both validates it and narrows
 * the detail. Extra envelope fields the API adds (`statusCode`, `error`,
 * `message`) are stripped on parse - this schema models the DOMAIN body, not
 * Nest's framing.
 */
const emailTakenBodySchema = z.object({
  code: z.literal("email_taken"),
});

const unitNameTakenBodySchema = z.object({
  code: z.literal("unit_name_taken"),
});

const propertyHasBookingsBodySchema = z.object({
  code: z.literal("property_has_bookings"),
  count: z.number().int().positive(),
});

const unitHasBookingsBodySchema = z.object({
  code: z.literal("unit_has_bookings"),
  count: z.number().int().positive(),
});

const datesUnavailableBodySchema = z.object({
  code: z.literal("dates_unavailable"),
  reasons: z.array(bookingRefusalReasonSchema).nonempty(),
});

const bookingNotCancellableBodySchema = z.object({
  code: z.literal("booking_not_cancellable"),
  status: bookingStatusSchema,
});

const bookingNotPayableBodySchema = z.object({
  code: z.literal("booking_not_payable"),
  status: bookingStatusSchema,
});

export const conflictBodySchema = z.discriminatedUnion("code", [
  emailTakenBodySchema,
  unitNameTakenBodySchema,
  propertyHasBookingsBodySchema,
  unitHasBookingsBodySchema,
  datesUnavailableBodySchema,
  bookingNotCancellableBodySchema,
  bookingNotPayableBodySchema,
]);
export type ConflictBody = z.infer<typeof conflictBodySchema>;

/**
 * Parse an arbitrary response body into a typed `ConflictBody`, or `null` if it
 * isn't a recognized conflict. The web calls this on a 409's raw body, then
 * switches on `.code`; anything unrecognized falls back to generic copy. Lenient
 * about the envelope's extra fields (see the schema note above) - it keys only on
 * `code` and the detail that code promises.
 */
export function parseConflictBody(body: unknown): ConflictBody | null {
  const parsed = conflictBodySchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
