import { randomUUID } from "node:crypto";
import { test, expect } from "../../fixtures/test";
import { futureIso, uniqueName } from "../../lib/helpers";

/**
 * Flow 6 - the channel-connection lifecycle (#173, SYNC-2/SYNC-3). The owner
 * connects an OTA iCal feed to a Unit, hands its export `.ics` back out, is
 * refused a duplicate, and disconnects - all on the property workbench's per-Unit
 * Channels panel (page-spec §4.5, #55).
 *
 * Owns its data end to end: it REGISTERS its own owner + tenant + property + unit
 * at runtime, so every channel write lands on a Unit no other test (or the seed's
 * Airbnb-on-Whole-Villa Baseline) shares. That is why this file overrides the
 * dashboard project's pooled owner storageState with a clean, signed-out context -
 * /register bounces an already-authenticated session to /app (its `beforeLoad`),
 * so the pooled owner cookie would make registration impossible.
 *
 * Four scenarios, one lifecycle, one login:
 *   1. Connect a reachable-shaped but UNREACHABLE feed -> it still connects, with
 *      `error` status (a down feed is a legible problem, not a failed request).
 *      Deterministic with no network fixture: `example.invalid` is a reserved TLD
 *      (RFC 6761) that never resolves, so the smoke-fetch fails fast.
 *   2. The export `.ics` is valid RFC-5545 for the Unit's confirmed bookings and
 *      carries NO PII - proven load-bearing by first booking a walk-in that DOES
 *      carry a name/phone/email/price, then asserting none of it reaches the feed
 *      (PII-free by construction, ADR-0016).
 *   3. Connecting the SAME (unit, channel) twice -> 409 `channel_already_connected`.
 *   4. Disconnect -> the connection is gone and the response reports
 *      `importedBookingsKept` (imports are kept, never auto-cancelled).
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("owner dashboard: channel connection lifecycle", () => {
  test("owner connects, exports, dedups, and disconnects an OTA feed", async ({
    page,
  }) => {
    // A long lifecycle (register + property + unit + walk-in + four channel
    // scenarios) across several cold Vite routes - well past the default 30s.
    test.setTimeout(120_000);

    const runId = randomUUID().slice(0, 8);
    const ownerEmail = `flow6-owner-${runId}@e2e.test`;
    const password = "sambung123";
    const tenantName = uniqueName("Flow6 Villas");
    const propertyName = uniqueName("Flow6 Property");
    const unitName = uniqueName("Flow6 Unit");

    // PII we deliberately store on a CONFIRMED booking, so scenario 2's "no PII"
    // is a real absence check, not a vacuously-empty feed.
    const guestName = uniqueName("Flow6 PII Guest");
    const guestPhone = "+62 811 7777 8888";
    const guestEmail = `pii-${runId}@guest.test`;
    const guestPrice = "7654321";

    // Far-future, own offset (+60/+62): guaranteed free on a brand-new Unit, and
    // clear of the other write specs (+45, +55).
    const checkIn = futureIso(60);
    const checkOut = futureIso(62);
    const windowFrom = futureIso(59);
    const windowTo = futureIso(63);

    const icalFeedUrl = "https://example.invalid/cal.ics";

    // --- Isolation: register our OWN owner + tenant (page-spec §3.4, FR-AUTH-1).
    await page.goto("/register");
    await page.getByLabel("Business name").fill(tenantName);
    await page.getByLabel("Email").fill(ownerEmail);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    // Signup starts the session and lands on the dashboard (which redirects to
    // the calendar). Reaching it IS the "did we register + authenticate" guard.
    await page.waitForURL("**/app/calendar");

    // --- Our OWN property. On a fresh tenant the list is empty, so the only
    // "New property" affordance is the empty-state one.
    await page.goto("/app/properties");
    await page.getByRole("button", { name: "New property" }).click();
    const createDialog = page.getByRole("dialog");
    await createDialog.getByLabel("Name").fill(propertyName);
    await createDialog.getByRole("button", { name: "Create" }).click();
    // Create navigates straight to the property workbench.
    await page.waitForURL(/\/app\/properties\/[0-9a-f-]{36}$/);
    const propertyUrl = page.url();

    // --- Our OWN unit, via the workbench's inline add row. Guests/min-stay keep
    // their defaults; a non-zero price makes it a sellable, bookable Unit.
    await page.getByLabel("New unit name").fill(unitName);
    await page.getByLabel("New unit price per night in rupiah").fill("1500000");
    await page.getByRole("button", { name: "Add unit" }).click();

    // The Channels panel picks the new Unit up and shows its export link. Read the
    // link off the panel (the owner's "copy the export URL" act) and pull the unit
    // id from it, rather than hardcoding a UUID a re-seed could change.
    const exportCode = page.locator("code", { hasText: "/calendar.ics" });
    await expect(exportCode).toBeVisible();
    const exportUrl = ((await exportCode.textContent()) ?? "").trim();
    const unitId = exportUrl.match(
      /units\/([0-9a-f-]{36})\/calendar\.ics/,
    )?.[1];
    expect(unitId, "export URL should carry the unit id").toBeTruthy();

    // --- A CONFIRMED booking on the Unit (a walk-in is born confirmed, ADR-0011),
    // carrying the PII scenario 2 proves the export feed never leaks. Drive the
    // calendar window via typed search params so the target empty cell is on
    // screen without paging the timeline.
    await page.goto(`/app/calendar?from=${windowFrom}&to=${windowTo}`);
    await page
      .getByRole("button", {
        name: `Add a booking on ${checkIn} in ${unitName}`,
      })
      .click();
    const bookingDialog = page.getByRole("dialog");
    await expect(bookingDialog).toBeVisible();
    await bookingDialog.getByRole("button", { name: /Walk-in/ }).click();
    await bookingDialog.getByLabel("Guest name").fill(guestName);
    await bookingDialog.getByLabel("Phone").fill(guestPhone);
    await bookingDialog.getByLabel("Email").fill(guestEmail);
    await bookingDialog.getByLabel("Check-out").fill(checkOut);
    await bookingDialog.getByLabel("Total price").fill(guestPrice);
    await bookingDialog.getByRole("button", { name: "Add walk-in" }).click();
    await expect(bookingDialog).toBeHidden();
    // The new bar carries the unique guest name, proving the confirmed booking
    // landed - it is what the export feed must describe without naming.
    await expect(page.getByText(guestName)).toBeVisible();

    // Back to the workbench for the channel scenarios.
    await page.goto(propertyUrl);

    // === Scenario 1: connect a down feed -> it still connects, with `error`.
    // The channel select defaults to Airbnb; we only supply the feed URL. `exact`
    // so "Connect" never also matches the "Disconnect" a live connection renders.
    await page.getByLabel("iCal URL").fill(icalFeedUrl);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    // `example.invalid` never resolves, so the smoke-fetch fails and the row lands
    // with the error status - the connection is created regardless (SYNC-3).
    await expect(page.getByText("Sync error")).toBeVisible({ timeout: 20_000 });

    // === Scenario 2: the export `.ics` is valid RFC-5545 and PII-free (SYNC-2).
    // Public feed - no auth (the unguessable unit id is the capability, ADR-0016),
    // so page.request (unauthenticated context) can fetch it directly.
    const feed = await page.request.get(exportUrl);
    expect(feed.status()).toBe(200);
    expect(feed.headers()["content-type"]).toContain("text/calendar");
    const ics = await feed.text();
    // Valid RFC-5545 envelope, and our confirmed booking as an all-day VEVENT.
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("SUMMARY:Unavailable (Sambung)");
    expect(ics).toContain("END:VCALENDAR");
    // Half-open [check_in, check_out) -> all-day DATE, DTEND exclusive (ADR-0016).
    expect(ics).toContain(`DTSTART;VALUE=DATE:${checkIn.replaceAll("-", "")}`);
    expect(ics).toContain(`DTEND;VALUE=DATE:${checkOut.replaceAll("-", "")}`);
    // No PII, BY CONSTRUCTION: the CalendarEvent type has no field for any of it.
    expect(ics).not.toContain(guestName);
    expect(ics).not.toContain(guestPhone);
    expect(ics).not.toContain(guestEmail);
    expect(ics).not.toContain(guestPrice);

    // === Scenario 3: connecting the SAME (unit, channel) again -> 409 (SYNC-3).
    // The select still holds Airbnb; supplying a URL and submitting re-attempts it.
    await page.getByLabel("iCal URL").fill(icalFeedUrl);
    const dupResponse = page.waitForResponse(
      (r) =>
        r.url().includes(`/units/${unitId}/channels`) &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const dup = await dupResponse;
    expect(dup.status()).toBe(409);
    const dupBody = (await dup.json()) as { code?: string };
    // The closed-set slug (ADR-0012), not the server's prose - the web owns copy.
    expect(dupBody.code).toBe("channel_already_connected");
    await expect(
      page.getByText("This channel is already connected to this unit"),
    ).toBeVisible();

    // === Scenario 4: disconnect -> gone, imports kept (SYNC-3).
    // Disconnect asks a native confirm; accept it. The DELETE reports how many
    // imported bookings remain - kept, never auto-cancelled (ADR-0016). Our
    // walk-in is a direct booking (no channel_connection_id), so zero imports were
    // ever attached to this connection.
    page.once("dialog", (d) => {
      void d.accept();
    });
    const delResponse = page.waitForResponse(
      (r) =>
        /\/channels\/[0-9a-f-]{36}$/.test(r.url()) &&
        r.request().method() === "DELETE",
    );
    await page.getByRole("button", { name: "Disconnect" }).click();
    const del = await delResponse;
    expect(del.status()).toBe(200);
    const delBody = (await del.json()) as { importedBookingsKept?: number };
    expect(delBody.importedBookingsKept).toBe(0);
    // The row is gone: the panel no longer shows any channel status.
    await expect(page.getByText("Sync error")).toHaveCount(0);
  });
});
