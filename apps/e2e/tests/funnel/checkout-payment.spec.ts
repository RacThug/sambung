import { test, expect } from "../../fixtures/test";
import { SEMINYAK_SLUG } from "../../setup/e2e-config";
import { futureIso, uniqueName } from "../../lib/helpers";

/**
 * Payment handoff, up to the trust boundary (blueprint Q7). The guest fills the
 * real checkout form, a real Hold is created (POST /public/bookings), and then
 * the app hands off to the payment provider - which we STUB at the network layer
 * so no request ever leaves for Midtrans. This is the documented way to cover the
 * money path without driving (or depending on) the external Snap UI.
 *
 * A WRITE test, so it claims a unique (unit, date-offset): Whole Villa at +55,
 * distinct from the calendar walk-in (Garden Room +45) and the availability quote
 * (a read).
 */
test.describe("public funnel: payment handoff (stubbed provider)", () => {
  test("guest completes checkout and is handed off to the payment provider", async ({
    page,
  }) => {
    // Discover the Whole Villa unit id from the real public contract, rather than
    // hardcoding a UUID a re-seed could change.
    const res = await page.request.get(
      `/api/public/properties/${SEMINYAK_SLUG}`,
    );
    expect(res.ok()).toBeTruthy();
    const property = (await res.json()) as {
      units: { id: string; name: string }[];
    };
    const villa = property.units.find((u) => u.name === "Whole Villa");
    expect(villa, "seed should have a Whole Villa unit").toBeTruthy();

    const from = futureIso(55);
    const to = futureIso(58); // 3 nights >= Whole Villa min stay (2)

    // Stub ONLY the provider session + the provider page. The Hold before it is
    // real; nothing here reaches Midtrans.
    await page.route("**/public/bookings/*/pay", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          token: "e2e-stub-token",
          redirectUrl: "https://snap.e2e.test/pay/stub",
        }),
      });
    });
    await page.route("https://snap.e2e.test/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<h1>Provider checkout (stub)</h1>",
      });
    });

    await page.goto(
      `/p/${SEMINYAK_SLUG}/book?unit=${villa!.id}&from=${from}&to=${to}`,
    );

    // Fill the guest details. Country defaults to Indonesia; the number is a valid
    // ID mobile so the server-side phone-validity check (#124) passes.
    await page.getByLabel("Full name").fill(uniqueName("E2E guest"));
    await page.getByLabel("WhatsApp number").fill("81234567890");

    await page.getByRole("button", { name: "Continue to payment" }).click();

    // The app created the Hold, opened the (stubbed) session, and redirected to
    // the provider - the whole funnel proven up to the trust boundary.
    await expect(page).toHaveURL("https://snap.e2e.test/pay/stub");
    await expect(
      page.getByRole("heading", { name: "Provider checkout (stub)" }),
    ).toBeVisible();
  });
});
