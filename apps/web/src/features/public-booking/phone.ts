import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";

/**
 * International phone handling for the checkout guest-details form (#54).
 *
 * A bare national number (`0812 3456 7890`) is genuinely ambiguous - the country
 * can't be recovered from the digits - so we capture it at the input: a country
 * selector resolves the ambiguity, and we submit unambiguous E.164. Only the
 * public funnel needs this, so `libphonenumber-js` is imported HERE (the web
 * bundle), never in `packages/shared` both sides import - the shared schema keeps
 * to a plain E.164 regex, the server's correctness boundary.
 *
 * The `/min` metadata build is used deliberately: it does full national → E.164
 * parsing/formatting for every country (all that needs the calling-code + trunk
 * rules), and `isValid()` on it validates by length. That keeps the bundle small
 * (~country-code metadata, not the full per-country pattern tables) while still
 * rejecting an implausible number - the server re-checks E.164 shape regardless.
 */

/** ISO country → English display name, from the platform's own Intl data (no
 * extra dependency, no shipped country list to maintain). */
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export type { CountryCode };

export interface CountryOption {
  code: CountryCode;
  name: string;
  callingCode: string;
}

/** Every country libphonenumber knows, labelled and sorted by name. Computed once. */
export const COUNTRY_OPTIONS: CountryOption[] = getCountries()
  .map((code) => ({
    code,
    name: regionNames.of(code) ?? code,
    callingCode: getCountryCallingCode(code),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Indonesia by default - this is a Bali direct-booking product. */
export const DEFAULT_COUNTRY: CountryCode = "ID";

/**
 * Convert a national (or already-international) number typed for `country` to
 * strict E.164, or null if it isn't a valid number for that country. This is the
 * one ambiguity resolver: `0812...` on ID → `+6281234567890`; `07911...` on GB →
 * `+447911123456`; a `+…` input parses regardless of the selected country.
 */
export function toE164(input: string, country: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(input, country);
  return parsed && parsed.isValid() ? parsed.number : null;
}
