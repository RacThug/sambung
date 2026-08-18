import { test, expect } from "../../fixtures/test";

/**
 * The honesty sync UX on a feed that has ACTUALLY synced (REQ-AV-04, spec UX-09).
 *
 * `channel-lifecycle.spec.ts` covers the other half - a feed that never synced
 * shows no age at all - but it cannot cover this half: the feed it connects is
 * refused by the SSRF guard on purpose, so it can never carry a real
 * `last_synced_at`. The seed can, and does: Bali Breeze's Whole Villa has an
 * Airbnb connection stamped half a cron cycle back (`seed.ts`, deliberately
 * relative so it never reads as "synced two years ago"), which is exactly the row
 * a real owner looks at every morning.
 *
 * Persona: OWNER of Bali Breeze - the dashboard project's pooled storageState, so
 * this spec signs in to nothing and writes nothing.
 *
 * Deliberately NOT asserted here: an age MOVING after a sweep. A successful pull
 * needs a reachable third-party feed, and no e2e in this repo waits on a resource
 * we do not own (#194). That the age is re-read after "Sync now" is proven in the
 * web suite (`channels-section.test.tsx`), where the feed is a stub.
 */
test.describe("owner dashboard: sync freshness", () => {
  test("the calendar and the workbench both name a real feed's age", async ({
    page,
  }) => {
    // --- The calendar answers "how current is this?" before anything is clicked.
    await page.goto("/app/calendar");
    const freshness = page.getByText(/OTA calendar/).first();
    await expect(freshness).toBeVisible();
    // The fleet line names an AGE, not a bare "synced". Loose about the number
    // AND about which honest state it is in: the seeded feed's `last_synced_at`
    // is real, so a suite run more than three sweeps after the seed legitimately
    // reads "last checked 2 hours ago - syncing may have stopped". Both sentences
    // carry the age, which is the requirement; pinning "checked" would make this
    // fail for being RIGHT.
    await expect(freshness).toHaveText(
      /OTA calendar (checked|last checked) .+ ago/,
    );

    // The standing iCal note is here too, leading with the leg we do not control.
    // Match the PARAGRAPH: the lead clause is emphasised in its own span, and the
    // two cadences the note contrasts only exist in the whole sentence.
    const note = page.locator("p", { hasText: /OTAs re-read your calendar/ }).first();
    await expect(note).toContainText("3 hours");
    await expect(note).toContainText("Refresh");

    // --- And the per-feed age is on the workbench, beside the status pill.
    await page.goto("/app/properties");
    await page.getByRole("link", { name: /Seminyak Beach Villa/ }).first().click();
    await page.waitForURL(/\/app\/properties\/[0-9a-f-]{36}$/);

    await expect(page.getByText("Synced")).toBeVisible();
    await expect(page.getByText(/Last synced .+ ago/)).toBeVisible();
  });
});
