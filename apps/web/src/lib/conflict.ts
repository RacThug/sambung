import {
  parseConflictBody,
  type BookingRefusalReason,
  type ConflictBody,
  type InviteRefusalReason,
} from "@sambung/shared";
import { ApiError } from "./api-client";

/**
 * The web's half of the 409 contract (#82, api-spec §8.2).
 *
 * The API sends a machine-readable `code` slug (+ typed detail) on every 409; the
 * web switches on it and composes its OWN copy here. Server prose is never
 * rendered - which is what makes these strings translatable (M5 i18n) and stops
 * the delete guard's count arriving as an un-parseable English sentence.
 *
 * `describeConflict` is a `switch` over the shared discriminated union, so adding
 * a slug to `@sambung/shared` without giving it copy here is a COMPILE error
 * (`assertNever`). This module is the one place to localize later.
 */

/** The typed 409 body carried by an error, or null if it isn't a recognized
 * conflict (a non-409, a non-ApiError, or a body the shared schema rejects - all
 * fall back to generic copy at the call site). */
export function conflictOf(error: unknown): ConflictBody | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  return parseConflictBody(error.body);
}

/** English copy for a conflict. Exhaustive over `ConflictBody['code']`. */
export function describeConflict(body: ConflictBody): string {
  switch (body.code) {
    // Field-level messages, no terminal period - matches the app's other field
    // errors (they sit under an input, not in a prose banner).
    case "email_taken":
      return "Email already registered";
    case "unit_name_taken":
      return "A unit with this name already exists in this property";
    // The count is composed HERE, from data - never rendered from a server
    // sentence (#82 AC). Property and unit read the same but name the right noun.
    case "property_has_bookings":
      return `This property has ${plural(body.count, "booking")} - deleting it would erase that history. Archive it instead to retire it while keeping the record.`;
    case "unit_has_bookings":
      return `This unit has ${plural(body.count, "booking")} - deleting it would erase that history. Archive it instead to retire it while keeping the record.`;
    case "dates_unavailable":
      return describeRefusal(body.reasons);
    case "booking_not_cancellable":
      return body.status === "cancelled"
        ? "This booking is already cancelled."
        : "This booking has already expired.";
    case "booking_not_payable":
      // The hold lapsed (swept to `expired`) or the booking already moved on. In
      // every case the guest must start over - the dates are no longer held.
      return body.status === "confirmed"
        ? "This booking is already confirmed."
        : "This hold has lapsed - please pick your dates again.";
    // Field-level (sits under the channel select), no terminal period.
    case "channel_already_connected":
      return "This channel is already connected to this unit";
    // The invite link resolved but is spent. Each reason gets its own NEXT STEP,
    // which is the whole reason the API sends a reason rather than one sentence:
    // "ask for a new one", "you already have an account", "talk to the owner".
    case "invite_not_acceptable":
      return describeInviteRefusal(body.reason);
    // Field-level (sits under the email input), no terminal period.
    case "invite_already_pending":
      return "An invite for this email is already pending";
    default:
      return assertNever(body);
  }
}

/**
 * One sentence for a blocked stay, chosen by the most decisive reason. A dead
 * unit (archived / unavailable) sends the user elsewhere, so it wins over an
 * overlap ("try other dates"); capacity and min-stay are the owner's policy.
 * Finer branching (re-quote vs back-to-search) is the caller's to do off
 * `body.reasons`; this is the readable fallback.
 */
function describeRefusal(reasons: readonly BookingRefusalReason[]): string {
  if (reasons.includes("archived") || reasons.includes("unavailable"))
    return "This unit is no longer available for new bookings.";
  if (reasons.includes("overlap"))
    return "Those dates were just taken. Refresh and try again.";
  if (reasons.includes("max_guests"))
    return "That's more guests than this unit can host.";
  if (reasons.includes("min_stay"))
    return "That stay is shorter than this unit's minimum.";
  return "Those dates can't be booked.";
}

/**
 * A spent invite, and what to do about it. Each reason has a different next
 * step, which is why the API sends a reason rather than one sentence: "already
 * used" means sign in, the other two mean ask for a new link.
 */
function describeInviteRefusal(reason: InviteRefusalReason): string {
  switch (reason) {
    case "accepted":
      return "This invite has already been used. Sign in with your email and password instead.";
    case "revoked":
      return "This invite was withdrawn. Ask the account owner to send you a new one.";
    case "expired":
      return "This invite has expired. Ask the account owner to send you a new one.";
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Compile-time exhaustiveness: an unhandled `code` makes `body` non-`never`. */
function assertNever(body: never): never {
  throw new Error(`Unhandled conflict body: ${JSON.stringify(body)}`);
}
