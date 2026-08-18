import { test, expect } from "../../fixtures/test";

/**
 * The honesty sync UX on a feed that has ACTUALLY synced (REQ-AV-04, spec UX-09).
 *
 * `channel-lifecycle.spec.ts` covers the other half - a feed that never synced
 * shows no age at all - but it cannot cover this half: the feed it connects is
 * refused by the SSRF guard on purpose, so it can never carry a real
 * `last_synced_at`. The seed can, and does: Bali Breeze's Whole Villa has an
 * Airbnb connection stamped half a cron cycle back
 * (`packages/db/scripts/seed.ts`, deliberately relative so it never reads as
 * "synced two years ago"), which is exactly the row a real owner looks at.
 *
 * Persona: OWNER of Bali Breeze - the dashboard project's pooled storageState, so
 * this spec signs in to nothing and writes nothing.
 *
 * WHY EVERY ASSERTION HERE IS STATE-AGNOSTIC. That seeded row does not hold still.
 * Two clocks move under it: the age grows past the 90-minute staleness line, and -
 * sharper - the 30-minute import cron runs against the dev API like it does in
 * production, tries the seeded `airbnb.com/...EXAMPLE.ics`, fails, and flips
 * `last_status` to `error`. So within an hour of a seed this same healthy row is
 * legitimately reported three different ways. Pinning "Synced", or the word
 * "checked", would make this spec fail for being RIGHT - a flake that costs more
 * trust than the assertion buys.
 *
 * What holds across all three states is the REQUIREMENT: a feed that has synced
 * names WHEN. A failed pull never stamps `last_synced_at`, so the age survives the
 * status flip on both surfaces - which is precisely the honesty being tested.
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
    // The fleet line names an AGE, whichever of the three honest states the
    // seeded feed is in by now (see the header): "checked 12 minutes ago",
    // "last checked 2 hours ago - syncing may have stopped", or "could not be
    // reached; last good check 2 hours ago". All three end in an age, because
    // UX-03a makes the age travel WITH the bad news - so this one assertion is
    // the requirement, not a snapshot of one lucky moment.
    await expect(freshness).toHaveText(/OTA calendar.* ago/);

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

    // Not the status pill - the cron may legitimately have flipped it to "Sync
    // error" by now. The AGE is what must be there either way: a failed pull
    // never stamps `last_synced_at`, so "when did this last really work" survives
    // exactly the failure that makes the question worth asking.
    await expect(page.getByText(/Last synced .+ ago/)).toBeVisible();
  });
});
