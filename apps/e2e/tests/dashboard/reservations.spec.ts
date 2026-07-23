import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect } from "../../fixtures/test";

/**
 * Flow 4 - the reservations list, its typed URL filters, the CSV export, and the
 * two empty states (#171, page-spec §4.2, ADR-0010). Clone of the dashboard read
 * pattern (staff-scope.spec.ts).
 *
 * Persona: OWNER of Bali Breeze (the dashboard project's default storageState).
 * READ-ONLY on the seeded Baseline - these tests never create or mutate a booking,
 * so the flow is safe alongside Flow 7 (which touches only inbox rows). The list is
 * COMPOSED on the client from the neutral reads (bookings + units + properties), and
 * the only e2e-owned behaviour is the URL<->list round-trip a unit test cannot see:
 * so the filters are driven through the URL, the way the app itself treats them
 * (README "Drive URL-state pages via the URL").
 *
 * Seed rows this reads (packages/db/scripts/seed.ts, all in the default upcoming
 * window `[today, today+366)`), for Bali Breeze:
 *   - "Wayan D."     confirmed direct   on Seminyak / Whole Villa (paid)
 *   - "Airbnb guest" confirmed airbnb   on Seminyak / Whole Villa
 *   - "Komang S."    pending_payment    on Seminyak / Garden Room (a Hold)
 *   - Manual block   confirmed block    on Canggu  / Surf Loft
 *   - "Late Payer"   expired direct     on Seminyak / Garden Room
 */
test.describe("dashboard: reservations list & CSV export (Flow 4, #171)", () => {
  // Scenario 1 - filter via URL (the URL<->list round-trip, CAL-3). A property
  // filter is the crispest, fully-stable narrowing (Canggu holds exactly the one
  // manual block; confirmed rows never auto-change status). Property over hardcoding
  // the seed uuid: the filtered URL is captured from the real UI action, then
  // re-opened, so nothing couples to an internal id.
  test("filtering by property narrows the list, and a pasted URL reproduces the view", async ({
    page,
  }) => {
    await page.goto("/app/reservations");

    // Baseline: the seeded Bali Breeze reservations are listed - a Seminyak guest
    // and the Canggu block, so both properties are present before we narrow.
    await expect(page.getByText("Wayan D.")).toBeVisible();
    await expect(page.getByText("Manual block")).toBeVisible();

    // Apply the property filter in the UI -> the typed param lands in the URL.
    await page
      .getByLabel("Property")
      .selectOption({ label: "Canggu Surf House" });
    await expect(page).toHaveURL(/propertyId=/);

    // ...and the list narrows to Canggu: the Surf Loft block stays, the Seminyak
    // guest drops out.
    await expect(page.getByText("Manual block")).toBeVisible();
    await expect(page.getByText("Wayan D.")).toHaveCount(0);

    const filteredUrl = page.url();

    // A pasted filtered URL reproduces the exact narrowed view. Navigate away first,
    // then open the captured URL cold, so the search params alone rebuild the state.
    await page.goto("/app/calendar");
    await page.goto(filteredUrl);
    await expect(page).toHaveURL(/propertyId=/);
    await expect(page.getByText("Manual block")).toBeVisible();
    await expect(page.getByText("Wayan D.")).toHaveCount(0);
  });

  // Scenario 2a - the FILTERED empty state. A far-past window is a touched filter
  // (from/to set) that matches nothing, so the copy is "No matches", NOT "No
  // upcoming reservations" - the distinction is keyed on the filter being touched,
  // not on the row count (both states have zero rows). 2b below proves the other arm.
  test("an explicit filter with no matches shows the filtered-empty copy", async ({
    page,
  }) => {
    // A legal window (from < to, <= 366 nights) far in the past -> the API returns
    // an empty list, and `from`/`to` make the view "filtered".
    await page.goto("/app/reservations?from=2019-01-01&to=2019-01-08");

    await expect(
      page.getByRole("heading", { name: "No matches" }),
    ).toBeVisible();
    await expect(
      page.getByText("No reservations match these filters."),
    ).toBeVisible();
    // Keyed on the touched filter: the untouched-empty copy must NOT appear here.
    await expect(
      page.getByRole("heading", { name: "No upcoming reservations" }),
    ).toHaveCount(0);
  });

  // Scenario 3 - the CSV export respects the active filter (CAL-3, #59). Drive a
  // status filter via the URL (confirmed only), then export: the file must carry the
  // windowed name + text/csv, include a row the filter keeps, and drop one it
  // excludes. The confirmed/paid guest is stable; the Hold guest is excluded whether
  // it is still `pending_payment` or has since lapsed, so the assertion is robust.
  test("Export CSV downloads a windowed text/csv that respects the active filter", async ({
    page,
  }) => {
    await page.goto("/app/reservations?status=confirmed");

    // Sanity: the filtered list is what we will export - the confirmed guest is
    // shown, the Hold guest is not.
    await expect(page.getByText("Wayan D.")).toBeVisible();
    await expect(page.getByText("Komang S.")).toHaveCount(0);

    // Arm both listeners before the click: the blob download (for the filename) and
    // the underlying HTTP response (for the content-type on the wire).
    const downloadPromise = page.waitForEvent("download");
    const responsePromise = page.waitForResponse((r) =>
      r.url().includes("/bookings/export.csv"),
    );
    await page.getByRole("button", { name: "Export CSV" }).click();
    const download = await downloadPromise;
    const response = await responsePromise;

    // text/csv on the wire...
    expect(response.headers()["content-type"]).toContain("text/csv");
    // ...and the windowed filename `reservations-<from>_<to>.csv` (default window).
    expect(download.suggestedFilename()).toMatch(
      /^reservations-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/,
    );

    // The file respects the confirmed filter: header contract present, the confirmed
    // guest kept, the Hold guest dropped.
    const csv = readFileSync(await download.path(), "utf8");
    expect(csv).toContain("Booking ID,Property,Unit,Guest");
    expect(csv).toContain("Wayan D.");
    expect(csv).not.toContain("Komang S.");
  });

  // Scenario 2b - the UNTOUCHED empty state. It needs a tenant with zero upcoming
  // bookings, which no seeded tenant is (they all have Baseline stays) and which the
  // state is keyed on (no filter + zero rows). The only honest way to reach it is a
  // FRESH owner: register a brand-new account, which creates its OWN isolated tenant
  // and never touches the Bali Breeze Baseline - the same "a write-test owns its own
  // data" convention the suite already uses (README Conventions). A clean session, so
  // /register is not bounced by the already-authed guard.
  test.describe("the untouched empty window (a tenant with no bookings)", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("shows 'No upcoming reservations', not the filtered-empty copy", async ({
      page,
    }) => {
      const suffix = randomUUID().slice(0, 8);
      await page.goto("/register");
      await page.getByLabel("Business name").fill(`Flow4 Empty ${suffix}`);
      await page.getByLabel("Email").fill(`flow4-empty+${suffix}@test.dev`);
      await page.getByLabel("Password").fill("supersecret1");
      await page.getByRole("button", { name: "Create account" }).click();

      // Register lands the new owner on the dashboard home; that is our "we are
      // signed in as an empty tenant" guard.
      await page.waitForURL("**/app/calendar");

      await page.goto("/app/reservations");
      await expect(
        page.getByRole("heading", { name: "No upcoming reservations" }),
      ).toBeVisible();
      // Keyed on NO touched filter: the filtered-empty copy must NOT appear.
      await expect(
        page.getByRole("heading", { name: "No matches" }),
      ).toHaveCount(0);
    });
  });
});
