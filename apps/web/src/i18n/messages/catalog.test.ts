import { describe, expect, it } from "vitest";
import { LOCALES } from "../locale";
import { en } from "./en";
import { id } from "./id";
import { zh } from "./zh";

/**
 * The untranslated-key guard (issue #58 AC, ADR-0024). The type annotation on
 * `id`/`zh` (`: Messages`) already makes a missing key a COMPILE error - this is
 * the runnable half: it also catches empty strings and a translator dropping a
 * `{token}`, and it is the CI-equivalent check that runs in `pnpm test`.
 */
const catalogs: Record<(typeof LOCALES)[number], Record<string, string>> = {
  en,
  id,
  zh,
};

const tokensOf = (value: string): string[] =>
  (value.match(/\{(\w+)\}/g) ?? []).sort();

describe("i18n catalogs", () => {
  const enKeys = Object.keys(en).sort();

  it("defines exactly the same keys in every locale (no EN-only copy)", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(catalogs[locale]).sort(), locale).toEqual(enKeys);
    }
  });

  it("has a non-empty string for every key in every locale", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect(value.trim().length, `${locale}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("uses the same interpolation tokens as English for every key", () => {
    for (const key of enKeys) {
      const expected = tokensOf(en[key as keyof typeof en]);
      for (const locale of LOCALES) {
        expect(tokensOf(catalogs[locale][key]), `${locale}.${key} tokens`).toEqual(
          expected,
        );
      }
    }
  });
});
