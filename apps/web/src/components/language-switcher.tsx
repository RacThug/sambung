import { LOCALES, type Locale } from "@/i18n/locale";
import { useI18n } from "@/i18n/context";

/** Each language named in ITS OWN language (endonyms) - a visitor who can't read
 * the current UI still recognizes their own. */
const ENDONYM: Record<Locale, string> = {
  en: "English",
  id: "Bahasa Indonesia",
  zh: "中文",
};

/**
 * The public funnel's language switcher (page-spec §2, ADR-0024). A native
 * `<select>`: keyboard- and screen-reader-friendly for free, mobile-native, and
 * trivially testable. Choice persists per visitor (localStorage, via the store).
 */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      aria-label={t("switcher.label")}
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {ENDONYM[l]}
        </option>
      ))}
    </select>
  );
}
