/**
 * A calendar date (`YYYY-MM-DD`) as the viewer reads it - "3 Mar 2027".
 *
 * One formatter for the dashboard, like `formatIdr` is for money. Dates follow the
 * VIEWER's locale (page-spec §2) - the opposite of money, which is always written
 * the Indonesian way - so the locale is left to the runtime (`undefined`). Parsed
 * at UTC because a calendar date has no time-of-day to shift: `2027-03-03` must
 * read as 3 March for a viewer in Bali and in Los Angeles alike, never slipping to
 * the 2nd across a timezone.
 */
const fmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export const formatDate = (iso: string): string =>
  fmt.format(new Date(`${iso}T00:00:00Z`));

/**
 * A MOMENT (an ISO-8601 instant, `…T07:57:00Z`) as the reader reads it -
 * "22 Jul 2026, 07.57". The other half of the pair above, and the distinction is
 * the whole point (#188, CONTEXT.md "Moment"):
 *
 *   - a calendar date has no time of day, so it is the same day for everyone and
 *     `formatDate` pins UTC to keep it that way;
 *   - a moment DOES have a time of day, so which calendar day it falls on depends
 *     on who is reading. Pinning UTC here would answer for a reader in London.
 *
 * That is exactly the bug this replaces: `formatDate(x.someAt.slice(0, 10))`
 * sliced an instant to its *UTC* day, so anything happening before 08:00 in WITA
 * - a third of every day, in the only timezones this product serves - rendered as
 * the day before. So no `timeZone` here: the runtime resolves the READER's zone,
 * the same reasoning that leaves the locale to the runtime.
 *
 * The time is shown, not just the day, so a zone can never be silently dropped
 * again: a bare day makes the ambiguity invisible, a visible clock time does not.
 * Built per call rather than cached at module scope so it follows a zone change
 * (which is how the test pins one).
 */
export const formatInstant = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` `n` days after `iso` (n may be negative). Parsed at UTC, so the
 * arithmetic never drifts a day across a DST boundary. */
export const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);

/** Today as a local `YYYY-MM-DD` - the owner's calendar day, not UTC. The anchor
 * for the reservations list's default "upcoming" window. */
export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
