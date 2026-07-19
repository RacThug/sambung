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
