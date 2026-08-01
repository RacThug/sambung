import type { BookingRefusalReason } from "@sambung/shared";

/**
 * Which refusal reason decides the message, when the server sends several.
 *
 * `dates_unavailable` carries an ARRAY of reasons (api-spec §5.3), and a stay can
 * fail two ways at once - too many guests for a unit that is also already booked.
 * The user gets one sentence, so something has to rank them, and the ranking is a
 * product judgement rather than a translation: a DEAD unit sends the guest back to
 * search, an overlap says "try other dates", and capacity or min-stay are the
 * owner's own policy and the last thing to mention.
 *
 * It lives here, once, because it used to live twice: `lib/conflict.ts` ranked them
 * for the English dashboard and `features/public-booking/availability-copy.ts`
 * ranked them again for the localized funnel, in two four-branch chains that had to
 * agree and nothing checked. Each caller still owns its own WORDS (the web owns all
 * 409 copy - ADR-0012); only the ordering is shared.
 *
 * Deliberately in `apps/web` and not `packages/shared`: the server sends the whole
 * set precisely so the client can decide what to lead with. Ranking is what the
 * reader needs, not what the wire means.
 *
 * Returns `null` for an empty or unrecognised set, which is the callers' cue to use
 * their generic line rather than assert a reason nobody sent.
 */
const PRECEDENCE: readonly BookingRefusalReason[] = [
  // A retired unit is off every sale path (ADR-0006), so no change of dates helps.
  "archived",
  // The guest-facing spelling of the same fact (ADR-0008): the public wire never
  // carries the owner's word "archived".
  "unavailable",
  // The nights are taken - the one refusal a different date range can fix.
  "overlap",
  // The owner's policy, in the order a guest can act on them.
  "max_guests",
  "min_stay",
];

export function primaryRefusalReason(
  reasons: readonly BookingRefusalReason[],
): BookingRefusalReason | null {
  return PRECEDENCE.find((reason) => reasons.includes(reason)) ?? null;
}
