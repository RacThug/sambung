/**
 * Locale-aware display formatters for the funnel (ADR-0024). The wire always
 * carries `YYYY-MM-DD`; these turn a value into what the visitor reads.
 *
 * Count-nouns ("N nights", "N guests") live here rather than in the string
 * catalog because the noun is locale-grammatical: EN inflects (1 night / 2
 * nights), ID and ZH do not mark plural. Keeping the grammar in code and the
 * surrounding sentence in the catalog is cleaner than encoding plural rules as
 * data.
 */
import { dateTag, type Locale } from "./locale";

const NIGHTS: Record<Locale, (n: number) => string> = {
  en: (n) => `${n} ${n === 1 ? "night" : "nights"}`,
  id: (n) => `${n} malam`,
  zh: (n) => `${n} 晚`,
};

/** "3 nights" / "3 malam" / "3 晚". */
export const formatNights = (n: number, locale: Locale): string =>
  NIGHTS[locale](n);

const GUESTS: Record<Locale, (n: number) => string> = {
  en: (n) => `${n} ${n === 1 ? "guest" : "guests"}`,
  id: (n) => `${n} tamu`,
  zh: (n) => `${n} 位客人`,
};

/** "2 guests" / "2 tamu" / "2 位客人". */
export const formatGuests = (n: number, locale: Locale): string =>
  GUESTS[locale](n);

/**
 * A calendar date in the visitor's locale (page-spec §2) - display only, the
 * wire stays `YYYY-MM-DD`. UTC-parsed so a calendar date never slips a day across
 * a timezone (the same reasoning as `lib/date.ts`, which the dashboard uses with
 * the browser locale; here the locale is explicit).
 */
export function formatDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(dateTag(locale), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}
