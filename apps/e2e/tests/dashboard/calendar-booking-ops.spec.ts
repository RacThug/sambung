import { randomUUID } from "node:crypto";
import { test, expect } from "../../fixtures/test";
import type { Page } from "@playwright/test";
import { futureIso, uniqueName } from "../../lib/helpers";

/**
 * Flow 3 - owner calendar & booking ops (#170, clone of manual-booking.spec.ts).
 *
 * The owner's operational core (CAL-3, ADR-0011 "the owner is an authority"): the
 * unified calendar, the block / walk-in create dialog, the booking-detail deep
 * link, the cancel FSM, and the shared overlap 409 (boss fight #1) surfaced in the
 * UI. e2e owns the render + the interactions; the SQL-level concurrency and FSM
 * guards are the api suite's job.
 *
 * ISOLATION (mandatory, README "Baseline vs per-test data"). Unlike the reference,
 * these tests do NOT lean on the seeded owner or the demo units. Each test
 * REGISTERS ITS OWN owner + tenant, then creates its own property + one unit
 * through the real UI, and writes only there. So every test is a self-contained
 * world - `fullyParallel` can't make two of them contend for the same nights, and
 * a re-run's leftovers are harmless (the next run re-provisions the DB). Stays are
 * claimed at `futureIso(65+)`, far past the seed's `[today+1, today+8)` packing.
 *
 * This spec runs unauthenticated: the `dashboard-desktop` project defaults to the
 * seeded owner's storageState, but here we clear it so `/register` isn't bounced
 * to `/app` by the already-authed guard - registration IS the sign-in.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Register a fresh owner (→ its own tenant), create one property and one unit
 * through the UI, and land back on the calendar. Returns the names the calendar's
 * accessible labels are keyed by, so a test can target its own unit unambiguously.
 */
async function setupOwnerWithUnit(
  page: Page,
): Promise<{ propertyName: string; unitName: string }> {
  const suffix = randomUUID().slice(0, 8);
  // Distinct tenant / property names: the sidebar renders the tenant name on every
  // dashboard page, so if it equalled the property name, `getByText(propertyName)`
  // on the detail page would match two elements (strict-mode violation).
  const businessName = `E2E Biz ${suffix}`;
  const propertyName = `E2E Villa ${suffix}`;
  const unitName = `E2E Suite ${suffix}`;

  // Register: creates the tenant + owner atomically and starts the session, so
  // there is no second login (page-spec §3.4). A fresh email every run.
  await page.goto("/register");
  await page.getByLabel("Business name").fill(businessName);
  await page.getByLabel("Email").fill(`e2e-flow3-${suffix}@example.test`);
  await page.getByLabel("Password").fill("sambung123");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/app/calendar");

  // Create the property: a fresh tenant has none, so the empty-state CTA is the
  // only "New property" affordance. Landing on the workbench is the success wait.
  await page.goto("/app/properties");
  await page.getByRole("button", { name: "New property" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Name").fill(propertyName);
  await createDialog.getByRole("button", { name: "Create" }).click();
  await page.waitForURL("**/app/properties/*");

  // Add one bookable unit via the inline add-row (aria-labels are unique to the
  // add row: "New unit …"). A price makes it sellable; guests/min-stay default.
  await page.getByLabel("New unit name").fill(unitName);
  await page
    .getByLabel("New unit price per night in rupiah")
    .fill("1500000");
  await page.getByRole("button", { name: "Add unit" }).click();
  // The created row appears in the units table - proof the write landed.
  await expect(page.getByRole("cell", { name: unitName })).toBeVisible();

  return { propertyName, unitName };
}

/** Open the calendar on a fixed `[from, to)` window (typed search params), so the
 * empty day cell we want is on screen without paging the timeline - the README's
 * "drive URL-state pages via the URL" rule, which also sidesteps geometry flake. */
async function openCalendar(page: Page, from: string, to: string): Promise<void> {
  await page.goto(`/app/calendar?from=${from}&to=${to}`);
}

/** Click the empty day cell for `date` on `unitName`'s row - every active-unit
 * cell is a real, labelled button (page-spec §4.1). Opens the create dialog. */
function emptyCell(page: Page, date: string, unitName: string) {
  return page.getByRole("button", {
    name: `Add a booking on ${date} in ${unitName}`,
  });
}

test.describe("owner calendar & booking ops", () => {
  test("1. walk-in: click an empty cell, add a guest, the bar appears", async ({
    page,
  }) => {
    const { unitName } = await setupOwnerWithUnit(page);
    const checkIn = futureIso(65);
    const checkOut = futureIso(67); // 2 nights, so the bar renders its label
    const guest = uniqueName("E2E walk-in");

    await openCalendar(page, futureIso(64), futureIso(69));
    await emptyCell(page, checkIn, unitName).click();

    // The dialog opens in Block mode; switch it to a walk-in (a real guest).
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Walk-in/ }).click();
    await dialog.getByLabel("Guest name").fill(guest);
    await dialog.getByLabel("Check-out").fill(checkOut);
    await dialog.getByRole("button", { name: "Add walk-in" }).click();

    // On success the dialog closes and the calendar invalidates + refetches; the
    // new bar carries our unique guest name, so it is unambiguous.
    await expect(dialog).toBeHidden();
    await expect(page.getByText(guest)).toBeVisible();
  });

  test("2. block + cancel: the bar appears, cancel frees the dates", async ({
    page,
  }) => {
    const { unitName } = await setupOwnerWithUnit(page);
    const checkIn = futureIso(70);
    const checkOut = futureIso(72); // 2-night block
    const from = futureIso(69);
    const to = futureIso(74);

    // --- Block the dates (manual_block, no guest, no price) ------------------
    await openCalendar(page, from, to);
    await emptyCell(page, checkIn, unitName).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Block is the default mode; just set the length and submit.
    await dialog.getByLabel("Check-out").fill(checkOut);
    await dialog.getByRole("button", { name: "Block dates" }).click();
    await expect(dialog).toBeHidden();

    // A manual block reads as "Manual" on the bar (SOURCE_META). It's the only
    // bar on our fresh unit, so the link is unambiguous.
    const blockBar = page.getByRole("link", { name: "Manual" });
    await expect(blockBar).toBeVisible();

    // --- Open the detail via the bar, then cancel ---------------------------
    await blockBar.click();
    await page.waitForURL("**/app/bookings/*");
    // Born confirmed (an owner block is authoritative, no hold), full detail.
    await expect(page.getByRole("heading", { name: "Manual block" })).toBeVisible();
    await expect(page.getByText("Confirmed")).toBeVisible();

    // A block's cancel verb is "Remove block" (ADR-0011: the universal
    // free-the-dates verb, worded for the case).
    await page.getByRole("button", { name: "Remove block" }).click();
    const confirm = page.getByRole("dialog");
    await confirm.getByRole("button", { name: "Yes, remove" }).click();

    // The status flips to Cancelled and the cancel affordance is gone (a
    // terminal booking is no longer occupying, so nothing to free).
    await expect(page.getByText("Cancelled")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove block" }),
    ).toHaveCount(0);

    // --- Prove the dates are genuinely bookable again -----------------------
    // Re-book the SAME nights. If the cancelled block still held them, the
    // exclusion constraint would 409 and no new bar would appear - so a fresh
    // "Manual" bar is the end-to-end proof the dates were freed.
    await openCalendar(page, from, to);
    await expect(page.getByRole("link", { name: "Manual" })).toHaveCount(0);
    await emptyCell(page, checkIn, unitName).click();
    const rebook = page.getByRole("dialog");
    await expect(rebook).toBeVisible();
    await rebook.getByLabel("Check-out").fill(checkOut);
    await rebook.getByRole("button", { name: "Block dates" }).click();
    await expect(rebook).toBeHidden();
    await expect(page.getByRole("link", { name: "Manual" })).toBeVisible();
  });

  test("3. overlap: a booking over an existing one surfaces the 409 banner", async ({
    page,
  }) => {
    const { unitName } = await setupOwnerWithUnit(page);
    const from = futureIso(73);
    const to = futureIso(81);

    // Existing booking A: a 3-night block over [76, 79).
    await openCalendar(page, from, to);
    await emptyCell(page, futureIso(76), unitName).click();
    const first = page.getByRole("dialog");
    await expect(first).toBeVisible();
    await first.getByLabel("Check-out").fill(futureIso(79));
    await first.getByRole("button", { name: "Block dates" }).click();
    await expect(first).toBeHidden();
    await expect(page.getByRole("link", { name: "Manual" })).toBeVisible();

    // Booking B: open from a FREE cell (74), then stretch check-out to 77 so
    // [74, 77) overlaps A[76, 79) at the 76th. The dialog trusts the server to
    // judge (ADR-0011/0013), so it lets us send an overlapping range.
    await emptyCell(page, futureIso(74), unitName).click();
    const second = page.getByRole("dialog");
    await expect(second).toBeVisible();
    await second.getByLabel("Check-out").fill(futureIso(77));
    await second.getByRole("button", { name: "Block dates" }).click();

    // The server refuses with the SAME 409 the guest funnel gives (boss fight #1,
    // `{ code: 'dates_unavailable', reasons: ['overlap'] }`); the web composes its
    // own copy from the slug (#82). The dialog stays open, banner shown.
    await expect(
      second.getByText("Those dates were just taken. Refresh and try again."),
    ).toBeVisible();
    await expect(second).toBeVisible();
  });

  test("4. detail deep-link (cold cache): fetches its own row and renders", async ({
    page,
  }) => {
    const { propertyName, unitName } = await setupOwnerWithUnit(page);
    const checkIn = futureIso(82);
    const checkOut = futureIso(84); // 2 nights → the bar labels + "2 nights" copy
    const guest = uniqueName("E2E deep-link");

    // Create a walk-in, then click its bar to reach the detail and learn the id.
    await openCalendar(page, futureIso(81), futureIso(86));
    await emptyCell(page, checkIn, unitName).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Walk-in/ }).click();
    await dialog.getByLabel("Guest name").fill(guest);
    await dialog.getByLabel("Check-out").fill(checkOut);
    await dialog.getByRole("button", { name: "Add walk-in" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("link", { name: guest }).click();
    await page.waitForURL("**/app/bookings/*");
    const detailUrl = page.url();

    // The point of the scenario: open the URL DIRECTLY with a cold cache. A full
    // navigation resets the SPA (in-memory access token gone → refresh cookie
    // re-auths, page-spec §4.3), so the detail page fetches its OWN row via
    // GET /bookings/:id rather than leaning on a warm calendar cache.
    await page.goto(detailUrl);

    await expect(page.getByRole("heading", { name: guest })).toBeVisible(); // guest
    await expect(page.getByText("Confirmed")).toBeVisible(); // status
    // dates: the labelled fields + the derived nights (locale-independent).
    await expect(page.getByText("Check-in", { exact: true })).toBeVisible();
    await expect(page.getByText("Check-out", { exact: true })).toBeVisible();
    await expect(page.getByText(/2 nights/)).toBeVisible();
    // and it resolved the right property/unit under RLS.
    await expect(page.getByText(propertyName)).toBeVisible();
    await expect(page.getByText(unitName)).toBeVisible();
  });
});
