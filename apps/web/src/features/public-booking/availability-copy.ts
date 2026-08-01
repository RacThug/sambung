/**
 * The picker + checkout copy, composed from the quote's machine-readable slugs +
 * data - never rendered from server prose (api-spec §5.1: the response is
 * language-neutral; the SPA localizes). This is the funnel's own half of the copy
 * contract, now locale-driven (ADR-0024): every function takes the `I18n` bag and
 * returns copy in the visitor's language. It mirrors `lib/conflict.ts` (which the
 * English-only dashboard keeps) - one module owns the strings.
 *
 * A `switch` over the reason enum makes an un-worded slug a COMPILE error
 * (`assertNever`), the same guard the conflict copy uses.
 */
import {
  lastNightOf,
  type AvailabilityReason,
  type BlockedRange,
  type BookingRefusalReason,
} from "@sambung/shared";
import type { I18n } from "@/i18n/context";
import { primaryRefusalReason } from "../../lib/refusal";

/** One line per picker refusal reason (`AvailabilityReason`: min_stay | overlap),
 * localized from the slug + the unit's own numbers. `min_stay` needs the minimum;
 * `overlap`'s specifics are the blocked nights, listed by `describeBlockedNights`. */
export function describeReason(
  i18n: I18n,
  reason: AvailabilityReason,
  minStay: number,
): string {
  switch (reason) {
    case "min_stay":
      return i18n.t("picker.reasonMinStay", { nights: i18n.fmtNights(minStay) });
    case "overlap":
      return i18n.t("picker.reasonOverlap");
    default:
      return assertNever(reason);
  }
}

/** A blocked `[from, to)` range as the occupied NIGHTS a guest reads, in the
 * visitor's date locale: a single night is one date, a run is "10 Aug - 12 Aug
 * 2026" (the checkout day, `to`, is excluded because it is free). Half-open math,
 * human words. */
export function describeBlockedNights(i18n: I18n, range: BlockedRange): string {
  const lastNight = lastNightOf(range);
  if (lastNight === range.from) return i18n.fmtDate(range.from);
  return `${i18n.fmtDate(range.from)} - ${i18n.fmtDate(lastNight)}`;
}

/**
 * The checkout create-409 refusal copy (`BookingRefusalReason`), localized. The
 * RANKING comes from `lib/refusal.ts`, shared with the dashboard's English twin in
 * `lib/conflict.ts`, so the two surfaces cannot disagree about which reason leads;
 * the funnel owns only its own translations.
 */
export function describeRefusal(
  i18n: I18n,
  reasons: readonly BookingRefusalReason[],
): string {
  switch (primaryRefusalReason(reasons)) {
    case "archived":
    case "unavailable":
      return i18n.t("conflict.unavailable");
    case "overlap":
      return i18n.t("conflict.overlap");
    case "max_guests":
      return i18n.t("conflict.maxGuests");
    case "min_stay":
      return i18n.t("conflict.minStay");
    default:
      return i18n.t("conflict.generic");
  }
}

function assertNever(x: never): never {
  throw new Error(`Unworded availability reason: ${JSON.stringify(x)}`);
}
