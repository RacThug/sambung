import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { getLocale, subscribeLocale } from "./locale";
import { createI18n, I18nContext, type I18n } from "./context";

/**
 * Bridges the framework-agnostic locale store into React via `useSyncExternalStore`
 * (the store is also read, React-free, by the api-client for `Accept-Language`) and
 * provides the memoized i18n bag (ADR-0024). The hook + factory live in
 * `./context` so this file exports only the component.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const value = useMemo<I18n>(() => createI18n(locale), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
