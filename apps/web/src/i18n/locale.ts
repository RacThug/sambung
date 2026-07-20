/**
 * The visitor's language: the framework-agnostic core of i18n (ADR-0024).
 *
 * A tiny external store (no library) so two very different readers can share one
 * source of truth: React (via `useSyncExternalStore` in the provider) and the
 * plain-fetch api-client (which sends `Accept-Language`, and must not import
 * React). The choice persists in `localStorage` - allowed for a language
 * *preference* (page-spec §2); it is NOT where tokens live (those stay in memory /
 * an httpOnly cookie - the never-localStorage rule is about credentials).
 */
export const LOCALES = ["en", "id", "zh"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const STORAGE_KEY = "sambung.lang";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * BCP-47 tags for `Intl` date formatting per app locale. EN funnel dates use
 * `en-GB` (day-month-year - the design-doc "3 Mar 2027" intent); the wire stays
 * `YYYY-MM-DD` regardless (ADR-0024). Money is `id-ID` everywhere, deliberately,
 * and lives in `lib/money.ts` - it is the currency's locale, not the visitor's.
 */
const DATE_TAG: Record<Locale, string> = {
  en: "en-GB",
  id: "id-ID",
  zh: "zh-CN",
};
export const dateTag = (locale: Locale): string => DATE_TAG[locale];

function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Privacy mode / no storage: fall through to browser language.
  }
  // First visit: honour the browser's language if we speak it, else English.
  const nav =
    typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "";
  if (nav.startsWith("id")) return "id";
  if (nav.startsWith("zh")) return "zh";
  return DEFAULT_LOCALE;
}

let current: Locale = detectInitial();
const listeners = new Set<() => void>();

export const getLocale = (): Locale => current;

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Best-effort persistence; the in-memory value still updates.
  }
  for (const listener of listeners) listener();
}

export function subscribeLocale(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}
