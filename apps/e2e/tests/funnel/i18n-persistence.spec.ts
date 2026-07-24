import { test, expect } from "../../fixtures/test";
import { SEMINYAK_SLUG, WEB_BASE_URL } from "../../setup/e2e-config";

/**
 * Flow 8 - the funnel's language choice PERSISTS across a page load (#175,
 * ADR-0024, FR-I18N-1). The foundation's `i18n.spec.ts` proves the switch
 * re-renders; this proves the choice survives the thing that kills every
 * in-memory store - a real document load.
 *
 * Deliberately opts OUT of the shared EN pin. `fixtures/test.ts` writes
 * `sambung.lang=en` from an init script that runs before page scripts on EVERY
 * navigation, which is exactly right for specs that assert English copy - and
 * exactly what would make this one lie: the pin would re-set EN on the second
 * navigation and "persistence" would be untestable. So this spec builds its own
 * context from the `browser` fixture, with no init script, and pins the BROWSER
 * language instead (`locale: en-US`) so the first-visit detection still starts
 * from English on any machine. `test`/`expect` still come from the shared
 * fixture, so the opt-out is one visible, local line rather than a second
 * convention.
 *
 * READ-ONLY: it browses two public pages and writes one localStorage key.
 */
test.describe("public funnel: language persistence", () => {
  test("a chosen language survives navigating to another funnel page", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: WEB_BASE_URL,
      locale: "en-US",
    });
    try {
      const page = await context.newPage();

      await page.goto(`/p/${SEMINYAK_SLUG}`);
      await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();

      // Switch through the real switcher (a native <select>, labelled by
      // `switcher.label` - "Language" while we are still in EN).
      await page.getByLabel("Language").selectOption("id");
      await expect(page.getByRole("heading", { name: "Kamar" })).toBeVisible();

      // The choice is a PREFERENCE, so localStorage is its home - the
      // never-localStorage rule is about credentials, not language (ADR-0024).
      await expect
        .poll(() =>
          page.evaluate(() => window.localStorage.getItem("sambung.lang")),
        )
        .toBe("id");

      // A full document load of ANOTHER funnel page: the locale store is
      // re-created from scratch and must read the visitor's choice back out of
      // storage. `goto`, not a client-side link, because a client-side link
      // would never unload the store this is testing.
      await page.goto("/");
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Pemesanan langsung tanpa komisi untuk penginapan di Bali.",
        }),
      ).toBeVisible();
      // The switcher itself came back in Indonesian too - its own label is
      // translated ("Bahasa"), and it shows the stored choice as selected.
      await expect(page.getByLabel("Bahasa")).toHaveValue("id");

      // And back on the page we started from, still Indonesian.
      await page.goto(`/p/${SEMINYAK_SLUG}`);
      await expect(page.getByRole("heading", { name: "Kamar" })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
