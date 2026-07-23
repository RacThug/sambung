import { test, expect } from "../../fixtures/test";
import { SEMINYAK_SLUG } from "../../setup/e2e-config";

/**
 * i18n, tested ON PURPOSE (blueprint Q6). Every other funnel spec runs pinned to
 * EN so a translation edit can't break it; this one drives the real language
 * switcher and asserts the funnel re-renders in Indonesian - proving the locale
 * seam (ADR-0024) end to end, in one place.
 *
 * The page loads pinned to EN (fixtures/test.ts). Selecting a language in the
 * switcher updates the store and re-renders WITHOUT navigating, so the EN pin
 * (an init script that runs on navigation) does not fight the switch.
 */
test.describe("public funnel: language switch", () => {
  test("switching to Bahasa Indonesia re-renders the funnel in Indonesian", async ({
    page,
  }) => {
    await page.goto(`/p/${SEMINYAK_SLUG}`);

    // EN first (the pinned default).
    await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();

    // The switcher is a native <select> labelled by switcher.label ("Language"
    // while we are still in EN); options carry the locale code as their value.
    await page.getByLabel("Language").selectOption("id");

    // Indonesian copy from the catalog (apps/web/src/i18n/messages/id.ts): the
    // page-level "Rooms" heading, and a unit-level button (scoped to one card,
    // since every unit renders the same "Cek ketersediaan" label). Unit NAMES
    // are data, not copy, so "Whole Villa" is unchanged by the switch.
    await expect(page.getByRole("heading", { name: "Kamar" })).toBeVisible();
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: "Whole Villa" })
        .getByRole("button", { name: "Cek ketersediaan" }),
    ).toBeVisible();
  });
});
