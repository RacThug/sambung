/**
 * The picker's copy, composed from the quote's machine-readable slugs + data -
 * never rendered from server prose (api-spec §5.1: the response is
 * language-neutral; the SPA localizes). This mirrors `lib/conflict.ts`: one
 * module owns the strings, so it is the single place to translate when the
 * public funnel gets EN/ID/ZH (M5, #58). Until then the strings are English
 * literals here rather than hardcoded across the JSX.
 *
 * A `switch` over the reason enum makes an un-worded slug a COMPILE error
 * (`assertNever`), the same guard the conflict copy uses.
 */
import {
  countNights,
  type AvailabilityReason,
  type BlockedRange,
} from "@sambung/shared";
import { addDays, formatDate } from "../../lib/date";

const nights = (n: number) => `${n} ${n === 1 ? "night" : "nights"}`;

/** One line per refusal reason, composed from the slug + the unit's own numbers.
 * `min_stay` needs the minimum; `overlap`'s specifics are the blocked nights,
 * listed separately by `describeBlockedNights`. */
export function describeReason(
  reason: AvailabilityReason,
  minStay: number,
): string {
  switch (reason) {
    case "min_stay":
      return `This room has a ${nights(minStay)} minimum stay.`;
    case "overlap":
      return "Some of those nights are already booked.";
    default:
      return assertNever(reason);
  }
}

/** A blocked `[from, to)` range as the occupied NIGHTS a guest reads: a single
 * night is one date, a run is "10 Aug - 12 Aug 2026" (the checkout day, `to`, is
 * excluded because it is free). Half-open math, human words. */
export function describeBlockedNights(range: BlockedRange): string {
  const lastNight = addDays(range.to, -1);
  if (lastNight === range.from) return formatDate(range.from);
  return `${formatDate(range.from)} - ${formatDate(lastNight)}`;
}

/** The available headline: nights count for the summary line. */
export function describeStay(from: string, to: string): string {
  return nights(countNights(from, to));
}

function assertNever(x: never): never {
  throw new Error(`Unworded availability reason: ${JSON.stringify(x)}`);
}
