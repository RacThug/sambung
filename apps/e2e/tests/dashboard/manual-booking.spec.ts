import { test, expect } from "../../fixtures/test";
import { futureIso, uniqueName } from "../../lib/helpers";

/**
 * Journey 2 - the owner dashboard (owner session reused from the setup project,
 * desktop viewport). The owner adds a walk-in on the calendar and sees it appear.
 *
 * Seams this reference exercises: storageState reuse (no re-login), per-test data
 * ownership (it creates its OWN booking with a unique guest name, on a far-future
 * date, so it never collides with the seed or a re-run), dashboard locators, and
 * a real write path (POST /bookings).
 */
test.describe("owner dashboard: create a manual booking", () => {
  test("owner adds a walk-in on the calendar and sees it appear", async ({
    page,
  }) => {
    const checkIn = futureIso(45); // free on every unit (seed packs into +1..+8)
    const checkOut = futureIso(47); // 2 nights, so the bar renders a label
    const windowFrom = futureIso(44);
    const windowTo = futureIso(50);
    const guest = uniqueName("E2E walk-in");
    const unitName = "Garden Room"; // a T1 unit with no far-future booking

    // Drive the calendar window via typed search params so the empty day cell for
    // our target date is on screen without paging the timeline.
    await page.goto(`/app/calendar?from=${windowFrom}&to=${windowTo}`);

    // Every empty day cell on an active unit row is a real, labelled button.
    await page
      .getByRole("button", {
        name: `Add a booking on ${checkIn} in ${unitName}`,
      })
      .click();

    // The dialog opens in Block mode; switch it to a walk-in (a real guest).
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Walk-in/ }).click();

    await dialog.getByLabel("Guest name").fill(guest);
    // Check-in defaults to the clicked day; extend the stay to two nights.
    await dialog.getByLabel("Check-out").fill(checkOut);
    await dialog.getByRole("button", { name: "Add walk-in" }).click();

    // On success the dialog closes and the calendar invalidates + refetches.
    await expect(dialog).toBeHidden();

    // The new bar carries our unique guest name, so it is unambiguous among the
    // seeded bars - the per-test data we own, proving the write landed.
    await expect(page.getByText(guest)).toBeVisible();
  });
});
