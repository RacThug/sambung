import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { depositAmountIdr } from "@sambung/shared";
import { test, expect } from "../../fixtures/test";
import { OWNER_DATABASE_URL, SEMINYAK_SLUG } from "../../setup/e2e-config";
import { futureIso, uniqueName } from "../../lib/helpers";

/**
 * Flow 1 (#168) - the guest funnel end to end: browse -> quote -> checkout ->
 * pay -> confirmation, for a booking's REAL status. This is the journey only e2e
 * can prove: the whole browser -> SPA -> API -> DB -> confirmation round-trip,
 * across the payment trust boundary. The interval/price math, the exclusion-
 * constraint concurrency, and the webhook's idempotency are the API's to test in
 * isolation; here we prove the pieces are wired together as a guest experiences
 * them.
 *
 * The money path uses the #167 `PAYMENT_GATEWAY=fake` seam (see the README's
 * *Payments* section): the pay call is REAL but hits the signature-free
 * FakePaymentGateway, so nothing ever leaves for Midtrans, and a settlement is
 * simulated by POSTing the provider's webhook shape. We NEVER drive the real Snap
 * UI.
 *
 * WRITE tests, so each claims a unique (unit, date-offset) no other spec uses:
 * the whole funnel writes on the seeded Seminyak / Whole Villa, at offsets 60-74
 * (checkout-payment holds +55, availability reads +45, the dashboard walk-in
 * +45 on a different unit). The happy write takes 60-63; the dates-taken race
 * 64-66; the min-stay quote 67-68; the lapsed hold 72-74.
 */

/** The seeded Whole Villa, discovered from the real public contract rather than a
 *  hardcoded UUID a re-seed could change. Carries the property's Deposit %, which
 *  fixes the amount the fake provider must "settle" for the webhook to confirm. */
async function getVilla(
  request: APIRequestContext,
): Promise<{ id: string; depositPct: number }> {
  const res = await request.get(`/api/public/properties/${SEMINYAK_SLUG}`);
  expect(res.ok()).toBeTruthy();
  const property = (await res.json()) as {
    depositPct: number;
    units: { id: string; name: string }[];
  };
  const villa = property.units.find((u) => u.name === "Whole Villa");
  expect(villa, "seed should have a Whole Villa unit").toBeTruthy();
  return { id: villa!.id, depositPct: property.depositPct };
}

/** A valid Indonesian mobile in canonical E.164 - passes both the shared shape
 *  schema and the server-side per-country validity check (#124), and yields a
 *  real `wa.me` deeplink on the confirmation page. */
const E164_PHONE = "+6281234567890";

/** Create a real Hold straight through the API (no browser), used to stage a
 *  competing booking and a to-be-lapsed hold. Returns the new booking id. */
async function createHold(
  request: APIRequestContext,
  unitId: string,
  from: string,
  to: string,
): Promise<string> {
  const res = await request.post("/api/public/bookings", {
    data: {
      unitId,
      checkIn: from,
      checkOut: to,
      guestName: uniqueName("API guest"),
      guestPhone: E164_PHONE,
      guestCount: 2,
    },
  });
  expect(res.ok(), "API hold should be created").toBeTruthy();
  const { bookingId } = (await res.json()) as { bookingId: string };
  return bookingId;
}

/**
 * Push a Hold's TTL into the past on the OWNER connection - the same statement
 * the cron sweeper runs. No public path can age a 15-minute hold, so this is the
 * only honest way to reach the lapsed state; the confirmation read then runs the
 * opportunistic hold-sweep (ADR-0009/0020) and flips the past-TTL pending hold to
 * `expired`. Uses the lane's own DB (OWNER_DATABASE_URL is lane-derived), so it
 * never touches another lane's data.
 */
async function ageHoldPast(bookingId: string): Promise<void> {
  const client = new Client({ connectionString: OWNER_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "update booking set hold_expires_at = now() - interval '1 hour' where id = $1",
      [bookingId],
    );
  } finally {
    await client.end();
  }
}

test.describe("public funnel: guest booking -> pay -> confirmation", () => {
  test("a guest books, pays, and lands on a confirmed booking with a wa.me deeplink", async ({
    page,
  }) => {
    const villa = await getVilla(page.request);
    const from = futureIso(60);
    const to = futureIso(63); // 3 nights >= Whole Villa min stay (2)

    // The amount the fake provider "settles" must equal the payment row's
    // snapshot, or the webhook's defense-in-depth amount check refuses to confirm.
    // Seminyak takes 100% up front, so the deposit share IS the full quoted total;
    // compute it from the SAME shared helper the server + checkout use, never a
    // hardcoded IDR figure.
    const quoteRes = await page.request.get(
      `/api/public/units/${villa.id}/availability?from=${from}&to=${to}`,
    );
    expect(quoteRes.ok()).toBeTruthy();
    const quote = (await quoteRes.json()) as {
      available: boolean;
      totalPriceIdr: number;
    };
    expect(quote.available).toBe(true);
    const amountIdr = depositAmountIdr(quote.totalPriceIdr, villa.depositPct);

    // With PAYMENT_GATEWAY=fake the pay call is real (it never reaches Midtrans)
    // and returns a fake Snap URL the app navigates to. Stub ONLY that external
    // page, so the handoff lands somewhere and no request leaves the machine. We
    // deliberately do NOT stub `.../pay`: the real fake gateway must create the
    // payment row, because order_id = payment.id is what the webhook resolves by
    // (README "Payments").
    await page.route("https://sandbox.example/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<h1>Provider checkout (stub)</h1>",
      }),
    );

    // The confirmation page needs the new booking id, which lives only in the
    // create response body - and `window.location.assign` to the provider discards
    // in-flight response bodies the instant it navigates. So capture it IN the
    // route handler (which reads the real response before the app ever sees it),
    // passing the response straight through so the funnel behaves normally. The
    // order_id we read afterwards from the redirect URL instead.
    let bookingId: string | undefined;
    await page.route("**/public/bookings", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      bookingId = ((await response.json()) as { bookingId: string }).bookingId;
      await route.fulfill({ response });
    });

    await page.goto(
      `/p/${SEMINYAK_SLUG}/book?unit=${villa.id}&from=${from}&to=${to}`,
    );
    await expect(
      page.getByRole("heading", { name: "Request to book" }),
    ).toBeVisible();

    await page.getByLabel("Full name").fill(uniqueName("E2E guest"));
    await page.getByLabel("WhatsApp number").fill("81234567890");

    await page.getByRole("button", { name: "Continue to payment" }).click();

    // The funnel created the Hold, opened the (real fake) session, and handed off to
    // the provider - proven to the trust boundary. The fake echoes payment.id (=
    // the webhook's order_id) into the redirect URL's last segment.
    await expect(page).toHaveURL(/^https:\/\/sandbox\.example\/pay\//);
    const orderId = new URL(page.url()).pathname.split("/").pop()!;
    expect(bookingId, "create response should have yielded a booking id").toBeTruthy();

    // Simulate the provider's settlement callback (no real Midtrans). A unique
    // transactionId keeps the idempotency key (transactionId:status) distinct.
    const hook = await page.request.post("/api/webhooks/payment/midtrans", {
      data: {
        orderId,
        transactionId: `e2e-${randomUUID()}`,
        transactionStatus: "settlement",
        grossAmountIdr: amountIdr,
      },
    });
    expect(hook.ok(), "webhook should ack").toBeTruthy();

    // The confirmation page reads the real, just-confirmed booking.
    await page.goto(`/booking/${bookingId!}`);
    await expect(
      page.getByRole("heading", { name: "You're all set" }),
    ).toBeVisible();
    const wa = page.getByRole("link", { name: "Send WhatsApp confirmation" });
    await expect(wa).toBeVisible();
    await expect(wa).toHaveAttribute("href", /^https:\/\/wa\.me\//);
  });

  test("an unknown property slug renders the not-found page", async ({
    page,
  }) => {
    await page.goto("/p/does-not-exist-e2e");
    await expect(
      page.getByRole("heading", { name: /doesn.t exist/i }),
    ).toBeVisible();
  });

  test("dates taken between quote and submit show the localized 'just taken' copy", async ({
    page,
  }) => {
    const villa = await getVilla(page.request);
    const from = futureIso(64);
    const to = futureIso(66); // 2 nights >= min stay

    // Wait for the checkout's mount re-quote to settle as AVAILABLE (arriving with
    // a free range). React Query's 30s staleTime means this cached "available"
    // quote will not refetch during the test, so injecting a competing hold below
    // cannot flip the button to disabled - the race we exercise is exactly a guest
    // submitting a stay taken since they quoted it (boss fight #1).
    const quotePromise = page.waitForResponse(
      (r) =>
        r.request().method() === "GET" &&
        new URL(r.url()).pathname.endsWith(`/units/${villa.id}/availability`) &&
        r.url().includes(`from=${from}`),
    );
    await page.goto(
      `/p/${SEMINYAK_SLUG}/book?unit=${villa.id}&from=${from}&to=${to}`,
    );
    const quoteBody = (await (await quotePromise).json()) as {
      available: boolean;
    };
    expect(quoteBody.available).toBe(true);

    // A competing guest grabs the exact nights (a real Hold via the API).
    await createHold(page.request, villa.id, from, to);

    await page.getByLabel("Full name").fill(uniqueName("E2E guest"));
    await page.getByLabel("WhatsApp number").fill("81234567890");
    await page.getByRole("button", { name: "Continue to payment" }).click();

    // The real 409 (booking_no_overlap) is composed into the funnel's OWN localized
    // copy (#82, ADR-0012), never rendered from server prose.
    await expect(
      page.getByText(
        "Those dates were just taken. Please refresh and try again.",
      ),
    ).toBeVisible();
  });

  test("a sub-min-stay range shows the localized minimum-stay reason", async ({
    page,
  }) => {
    const villa = await getVilla(page.request);
    const from = futureIso(67);
    const to = futureIso(68); // 1 night < Whole Villa min stay (2)

    // The picker opens for the unit named in `?unit`, and drives its quote from the
    // `?from&to` in the URL (the funnel's typed-URL convention). The server is the
    // one min-stay authority; the card just localizes its verdict.
    await page.goto(`/p/${SEMINYAK_SLUG}?unit=${villa.id}&from=${from}&to=${to}`);
    await expect(
      page.getByText("Not available for these dates"),
    ).toBeVisible();
    await expect(
      page.getByText("This room has a 2 nights minimum stay."),
    ).toBeVisible();
  });

  test("the confirmation page for a lapsed hold shows 'Your hold has lapsed'", async ({
    page,
  }) => {
    const villa = await getVilla(page.request);
    const from = futureIso(72);
    const to = futureIso(74); // 2 nights >= min stay

    const bookingId = await createHold(page.request, villa.id, from, to);
    // No public path ages a 15-minute hold; push its TTL into the past exactly as
    // the sweeper would. The confirmation read runs the opportunistic sweep, so the
    // page tells the truth immediately instead of on the next cron tick.
    await ageHoldPast(bookingId);

    await page.goto(`/booking/${bookingId}`);
    await expect(
      page.getByRole("heading", { name: "Your hold has lapsed" }),
    ).toBeVisible();
  });
});
