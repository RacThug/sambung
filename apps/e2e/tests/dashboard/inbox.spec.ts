import type { Page } from "@playwright/test";
import type { BookingConfirmationResponse } from "@sambung/shared";
import { test, expect } from "../../fixtures/test";

/**
 * Flow 7 - the operations inbox (#174), as the seeded Bali Breeze owner (the
 * dashboard project's storageState).
 *
 * `/app/inbox` is the one page for "the system did the safe thing and is now
 * stuck": a refused OTA import (#38, ADR-0027) above a payment that settled after
 * its hold lapsed (#120, ADR-0022). Both are cleared by a HUMAN, and both clearing
 * verbs are deliberately *narrow* - dismiss writes only `sync_conflict.status`,
 * handle writes only `payment.handled_at`. Neither touches the ledger; an item
 * leaves the inbox because the list's predicate stops matching it.
 *
 * e2e owns: that both queues render with enough to act on, that the two verbs work
 * through the real UI, that the sidebar badge is the two queues summed, and - the
 * assertion that makes ADR-0022 real rather than claimed - that handling a lapsed
 * payment leaves the money and the booking exactly as they were.
 * Defers to api: conflict detection, webhook idempotency, the sweepers (BF#3/#4).
 *
 * ## Why `describe.serial` (the one deliberate exception to the write conventions)
 *
 * Every other write-spec creates its OWN data, because the suite is
 * `fullyParallel`. This one cannot: a sync conflict needs a reachable https feed
 * (the fetcher blocks localhost by design, ADR-0016) and a paid-but-lapsed payment
 * needs a settlement after a sweep, so both arrive as Baseline SEED fixtures
 * (#167). That makes this the only flow that mutates seeded rows - and the two
 * tests below both depend on the pre-mutation count, so running them in parallel
 * would race the badge. `describe.serial` pins them to one worker, in order:
 * conflict first (2 -> 1), payment second (1 -> 0). Everything they mutate
 * (`sync_conflict.status`, `payment.handled_at`) is re-seeded on the next run and
 * is read by no other flow.
 *
 * For the same reason this spec must stay in exactly ONE Playwright project.
 * `describe.serial` orders tests within a project; it does nothing across them, so
 * a second project matched to this file would run a second copy against the SAME
 * seeded rows and the two would race the dismiss/handle. This is the identical
 * hazard `playwright.config.ts` already calls out for `checkout-payment.spec.ts`
 * (two engines contending for the same nights) - there the shared resource is a
 * unit's dates, here it is a seeded row.
 */

/** The sidebar's Inbox nav item. Its ACCESSIBLE NAME carries the badge, because
 *  the count is exposed as the badge span's `aria-label` ("2 items need
 *  attention") - so asserting the name is asserting exactly what the badge tells
 *  a screen-reader user. `name` matches on substring, so this one locator finds
 *  the link whatever the count is (including none). */
const inboxNav = (page: Page) => page.getByRole("link", { name: "Inbox" });

/**
 * The booking's public confirmation view - the only read that exposes BOTH halves
 * of the ledger in one answer: the booking's own `status`, and `amountPaidIdr`,
 * which the API computes as the sum of that booking's payments whose status is
 * `paid`. So an unchanged pair after "Mark handled" proves the handle wrote
 * neither the payment's status nor the booking's (ADR-0022). Unauthenticated by
 * design (the unguessable booking UUID is the key), and `page.request` inherits
 * the project's baseURL, so it goes through the same Vite `/api` proxy the app
 * uses.
 */
async function readLedger(
  page: Page,
  bookingId: string,
): Promise<BookingConfirmationResponse> {
  const res = await page.request.get(`/api/public/bookings/${bookingId}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as BookingConfirmationResponse;
}

/** `Rp 3.600.000` from integer rupiah - the SPA's `formatIdr`, which pins the
 *  separators to id-ID for every viewer (money is written the Indonesian way,
 *  dates follow the viewer). Mirrored here rather than imported so the spec
 *  asserts the rendered string a human reads, not the function that made it. */
const formatIdr = (n: number) =>
  `Rp ${new Intl.NumberFormat("id-ID").format(n)}`;

test.describe.serial("owner dashboard: the operations inbox", () => {
  test("dismisses the seeded sync conflict, and the badge decrements", async ({
    page,
  }) => {
    await page.goto("/app/inbox");

    // The badge is the two queues SUMMED (page-spec §4.6): the seed leaves Bali
    // Breeze with exactly one open conflict and one paid-but-lapsed payment, and
    // this is the only flow that mutates either.
    await expect(inboxNav(page)).toHaveAccessibleName(
      "Inbox 2 items need attention",
    );

    await expect(
      page.getByRole("heading", { name: "Calendar conflicts" }),
    ).toBeVisible();

    // The refused import: Airbnb sold nights on the Whole Villa. "Airbnb" appears
    // only in this row's headline (the blocking booking below it is Direct), so it
    // identifies the conflict unambiguously.
    const conflict = page
      .getByRole("listitem")
      .filter({ hasText: /Airbnb booking/ });
    await expect(conflict).toHaveCount(1);
    await expect(
      conflict.getByText("Seminyak Beach Villa - Whole Villa"),
    ).toBeVisible();

    // ...WITH the blocking booking, derived server-side from the same overlap test
    // the exclusion constraint uses. Without it the owner is told there is a clash
    // but not what is in the way, so this is the half of the row that makes the
    // inbox actionable - and the "View booking" link is how they act on it.
    await expect(conflict.getByText("Already booked here")).toBeVisible();
    const blocking = conflict
      .getByRole("listitem")
      .filter({ hasText: "Wayan D." });
    await expect(blocking).toHaveCount(1);
    await expect(blocking.getByText("Confirmed")).toBeVisible();
    await expect(
      blocking.getByRole("link", { name: /View booking/ }),
    ).toHaveAttribute("href", /^\/app\/bookings\/[0-9a-f-]{36}$/);

    // TWO stays, not one. The seed shapes this clash as a PARTIAL overlap on
    // purpose (packages/db/scripts/seed.ts): identical dates would hide a row that
    // conflated the OTA's refused stay with the booking standing in its way, and
    // the owner would be shown one range for a problem that has two. That the
    // ranges OVERLAP is not re-asserted here - `blockingBookings` is derived
    // server-side by the same `daterange &&` the exclusion constraint uses, so the
    // blocking row existing at all IS the overlap.
    //
    // Compared as RENDERED strings rather than parsed dates: `formatDate` follows
    // the viewer's locale (page-spec §2), so pinning a locale to parse them back
    // would be testing the formatter, not the row.
    const otaStayLine = await conflict
      .getByRole("paragraph")
      .filter({ hasText: "→" })
      .innerText();
    // Drop the "(3 nights)" suffix, leaving just "<check-in> → <check-out>".
    const otaStay = otaStayLine.split(" (")[0]?.trim() ?? "";
    expect(otaStay).toMatch(/\d.+→.+\d/);
    const blockingText = (await blocking.innerText()).replace(/\s+/g, " ");
    expect(blockingText).toMatch(/\d.+→.+\d/);
    expect(blockingText).not.toContain(otaStay);

    // Dismiss is a JUDGEMENT (ADR-0027): it writes only status + closed_at, and
    // there is deliberately no "resolve" button - resolution is measured by the
    // next sync, never asserted by the UI.
    await conflict.getByRole("button", { name: "Dismiss" }).click();

    // The section now KEEPS its heading and says "No conflicts" (divergence D3,
    // resolved 2026-08-02). It used to render nothing at all once the queue
    // emptied - which also meant a FAILED read looked identical to a quiet one, on
    // the page whose whole job is surfacing what needs attention. So the all-clear
    // appearing, not the heading vanishing, is now the item leaving the inbox.
    await expect(
      page.getByRole("heading", { name: "Calendar conflicts" }),
    ).toBeVisible();
    await expect(page.getByText("No conflicts")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Payments needing attention" }),
    ).toBeVisible();

    await expect(inboxNav(page)).toHaveAccessibleName(
      "Inbox 1 item needs attention",
    );
  });

  test("handles the seeded paid-but-lapsed payment, and the ledger is untouched", async ({
    page,
  }) => {
    await page.goto("/app/inbox");

    // One item left - the conflict was dismissed by the test above (serial).
    await expect(inboxNav(page)).toHaveAccessibleName(
      "Inbox 1 item needs attention",
    );

    // The late settlement: the guest paid after their hold was swept to `expired`,
    // so the money is captured and the dates are not held. The row shows enough to
    // act on - amount, guest, the stay it was for, and a link to the booking.
    const lapsed = page.getByRole("listitem").filter({ hasText: "Late Payer" });
    await expect(lapsed).toHaveCount(1);
    await expect(lapsed.getByText("Expired")).toBeVisible();
    await expect(
      lapsed.getByText("Seminyak Beach Villa - Garden Room"),
    ).toBeVisible();

    // The booking id comes off the row's own link rather than being mirrored from
    // the seed - one less constant to drift.
    const href = await lapsed
      .getByRole("link", { name: /View booking/ })
      .getAttribute("href");
    const bookingId = href?.split("/").pop() ?? "";
    expect(bookingId).toMatch(/^[0-9a-f-]{36}$/);

    // The ledger BEFORE. `amountPaidIdr > 0` is the point: a payment for this
    // booking is settled, which is the whole reason the item is in the inbox.
    const before = await readLedger(page, bookingId);
    expect(before.status).toBe("expired");
    expect(before.amountPaidIdr).toBeGreaterThan(0);
    // The seed gives this booking exactly one payment, so the money the inbox
    // shows and the money the ledger records are the same number.
    await expect(
      lapsed.getByText(formatIdr(before.amountPaidIdr)),
    ).toBeVisible();

    await lapsed.getByRole("button", { name: "Mark handled" }).click();

    // Gone from the queue - and the section says so explicitly rather than
    // vanishing, because "no payments need attention" is news an owner wants.
    await expect(page.getByText("Late Payer")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "All clear" }),
    ).toBeVisible();

    // The badge is now zero, so no badge at all: the link's accessible name is
    // exactly "Inbox".
    await expect(inboxNav(page)).toHaveAccessibleName("Inbox");

    // ...and the ledger is BYTE-FOR-BYTE what it was. `handle` wrote a nullable
    // `handled_at` marker and nothing else: the payment is still `paid` (so the
    // settled sum is unmoved) and the booking is still `expired`. The item left the
    // inbox because the list's predicate stopped matching it, NOT because anything
    // about the money or the calendar changed (ADR-0022, the ADR-0002 rule
    // generalized: a record is never corrupted to satisfy a UI).
    const after = await readLedger(page, bookingId);
    expect(after.status).toBe(before.status);
    expect(after.amountPaidIdr).toBe(before.amountPaidIdr);
    expect(after.totalPriceIdr).toBe(before.totalPriceIdr);

    // Idempotent by construction (ADR-0022): a reload shows the same cleared inbox
    // rather than the row coming back.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "All clear" }),
    ).toBeVisible();
    await expect(page.getByText("Late Payer")).toHaveCount(0);
  });
});
