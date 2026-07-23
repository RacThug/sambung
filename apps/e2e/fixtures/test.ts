import { test as base, expect } from "@playwright/test";

/**
 * The `test` every spec imports (not `@playwright/test` directly), so one
 * convention applies everywhere: the funnel's locale is pinned to EN.
 *
 * Why: the public funnel is EN/ID/ZH (ADR-0024), chosen from `localStorage`
 * (`sambung.lang`) and the browser language. Without a pin, a machine set to
 * Indonesian would render the funnel in ID and every `getByText`/`getByRole`
 * that names English copy would miss. We pin here so text locators are
 * deterministic, and test i18n on PURPOSE in a dedicated spec instead of letting
 * locale be a source of ambient flakiness (blueprint Q6). Harmless on the
 * English-only dashboard, which never reads this key.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("sambung.lang", "en");
      } catch {
        // Storage blocked (unlikely in a test browser); EN is the default anyway.
      }
    });
    await use(context);
  },
});

export { expect };
