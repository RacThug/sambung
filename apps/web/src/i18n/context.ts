import { createContext, useContext } from "react";
import type { Locale } from "./locale";
import { setLocale as setLocaleStore } from "./locale";
import { formatDate, formatGuests, formatNights } from "./format";
import { messages, type MessageKey } from "./messages";

/**
 * The i18n context + typed translator (ADR-0024), kept apart from the provider
 * component so this module exports no component (fast-refresh clean). Copy
 * composition stays in the feature copy modules (`availability-copy.ts`) - this
 * only resolves + interpolates.
 *
 * `t(key)` is typed to the catalog keys, so a typo is a compile error; params fill
 * `{token}` placeholders.
 */
type Params = Record<string, string | number>;

export interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Params) => string;
  fmtDate: (iso: string) => string;
  fmtNights: (n: number) => string;
  fmtGuests: (n: number) => string;
}

export const I18nContext = createContext<I18n | null>(null);

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

/**
 * Build the i18n bag for a locale - pure, no React. The provider memoizes it per
 * locale; copy-module unit tests use it directly to assert localized output across
 * all three languages without mounting a component.
 */
export function createI18n(locale: Locale): I18n {
  const dict = messages[locale];
  return {
    locale,
    setLocale: setLocaleStore,
    t: (key, params) => interpolate(dict[key], params),
    fmtDate: (iso) => formatDate(iso, locale),
    fmtNights: (n) => formatNights(n, locale),
    fmtGuests: (n) => formatGuests(n, locale),
  };
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}
