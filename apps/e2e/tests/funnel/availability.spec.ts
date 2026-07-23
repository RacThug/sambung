import { test, expect } from "../../fixtures/test";
import { SEMINYAK_SLUG } from "../../setup/e2e-config";
import { futureIso } from "../../lib/helpers";

/**
 * Journey 1 - the public funnel (no auth, mobile viewport). A guest opens a
 * shared property link, gets an available quote, and proceeds to checkout.
 *
 * Seams this reference exercises: the unauthenticated path, the Baseline seed,
 * the EN locale pin, the availability quote (boss fight #2's read side), and
 * typed-URL navigation. Stops at the payment trust boundary (blueprint Q7).
 */
test.describe("public funnel: browse -> quote -> book", () => {
  test("a guest opens a property, gets an available quote, and proceeds to checkout", async ({
    page,
  }) => {
    // --- render, from the Baseline seed, with no session ---
    await page.goto(`/p/${SEMINYAK_SLUG}`);
    await expect(
      page.getByRole("heading", { name: "Seminyak Beach Villa", level: 1 }),
    ).toBeVisible();

    // --- real interaction: open a unit's availability picker ---
    const villa = page.getByRole("listitem").filter({ hasText: "Whole Villa" });
    await villa.getByRole("button", { name: "Check availability" }).click();

    // The URL is the picker's single source of truth (the component documents
    // this): opening a unit writes `?unit=<id>`. Read the id back rather than
    // hardcoding a UUID that a re-seed could change.
    await expect(page).toHaveURL(/[?&]unit=/);
    const unitId = new URL(page.url()).searchParams.get("unit");
    expect(unitId).toBeTruthy();

    // The empty-state helper text proves the picker mounted.
    await expect(
      page.getByText(
        "Select your check-in and check-out dates to see availability and price.",
      ),
    ).toBeVisible();

    // --- quote a far-future range (guaranteed free; see futureIso) by loading
    // the URL a shared availability link would use. Driving date-state through
    // the URL is deterministic and matches how the app treats it, instead of
    // fighting calendar-cell geometry (blueprint Q6). ---
    const from = futureIso(45);
    // 3 nights, comfortably >= the Whole Villa's seeded min stay (2). We target
    // that Baseline unit specifically, so this is a known fixture fact, not an
    // assumption about every unit.
    const to = futureIso(48);
    await page.goto(`/p/${SEMINYAK_SLUG}?unit=${unitId}&from=${from}&to=${to}`);

    await expect(page.getByText("Available", { exact: true })).toBeVisible();
    const book = page.getByRole("link", { name: "Book these dates" });
    await expect(book).toBeVisible();

    // --- proceed to checkout; the quoted range rides along in the typed URL ---
    await book.click();
    await expect(page).toHaveURL(new RegExp(`/p/${SEMINYAK_SLUG}/book`));
    await expect(page).toHaveURL(new RegExp(`from=${from}`));
    await expect(page.getByText("Request to book")).toBeVisible();
  });
});
