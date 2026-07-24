import { test, expect } from "../../fixtures/test";
import {
  DEMO_PASSWORD,
  OWNER_EMAIL,
  STAFF_STATE,
} from "../../setup/e2e-config";

/**
 * Flow 8 - auth, session and the workspace switch (#175).
 *
 * What only e2e can see: Sambung's session lives in TWO places by design - the
 * access token in MEMORY (never localStorage) and the refresh token in an
 * httpOnly cookie (architecture §4.4). A unit test can assert `ensureSession()`
 * in isolation; only a real browser can prove that a reload - which wipes the
 * in-memory half - is silently repaired by the cookie half, that the guard's
 * `?next` round-trips through a real form submit, and that logging out actually
 * ends the session rather than merely hiding the nav.
 *
 * READ-ONLY: every scenario here logs in, reloads, logs out, or switches seat.
 * None mutates a domain row, so this file is safe alongside every write flow.
 *
 * Isolation note: `POST /auth/logout` and `POST /auth/session` re-issue or clear
 * the refresh cookie in THIS context only - refresh tokens are stateless JWTs
 * with no server-side revocation, and no test here rewrites a `storageState`
 * file. So a logout below can never sign out a parallel spec.
 */

test.describe("dashboard auth: the guard and the return trip", () => {
  // Signed OUT, deliberately: this describe overrides the dashboard project's
  // owner storageState with an empty one, so the guard has nothing to restore.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a protected route bounces to /login?next and login returns there", async ({
    page,
  }) => {
    await page.goto("/app/calendar");

    // The guard bounced us. Assert the CONTRACT (path + the parsed `next`),
    // not the encoded query string - `?next=%2Fapp%2Fcalendar` is the router's
    // serialization detail, `next === "/app/calendar"` is the promise.
    await page.waitForURL((url) => url.pathname === "/login");
    expect(new URL(page.url()).searchParams.get("next")).toBe("/app/calendar");

    // The real form, the real credentials - the one place besides the auth
    // setup where the login journey is exercised end to end.
    await page.getByLabel("Email").fill(OWNER_EMAIL);
    await page.getByLabel("Password").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // Back where we were headed - NOT the default /app landing. That difference
    // is the whole point of `?next`, so assert the page actually rendered.
    await page.waitForURL("**/app/calendar");
    await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  });
});

test.describe("dashboard session: refresh, logout, already-authed", () => {
  // Inherits the dashboard project's owner storageState (the refresh cookie the
  // setup project saved). Each test gets its OWN context loaded from that file.

  test("a reload silently refreshes the session from the httpOnly cookie", async ({
    page,
  }) => {
    await page.goto("/app/calendar");
    await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();

    // A reload throws the in-memory access token away. Watch for the refresh
    // call itself, so this asserts the MECHANISM (the cookie bought us a new
    // token) rather than just the happy outcome.
    const refreshed = page.waitForResponse(
      (res) =>
        res.url().includes("/api/auth/refresh") &&
        res.request().method() === "POST",
    );
    await page.reload();
    expect((await refreshed).status()).toBe(200);

    // Still signed in, still on the same page - no bounce to /login.
    await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Account menu" }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/app/calendar");

    // The NEGATIVE half of "in memory only": with a live session on screen, web
    // storage holds the language preference and NOTHING else - no access token,
    // and no refresh token either (that one is an httpOnly cookie the page
    // cannot read). An exact allowlist rather than a "no token" heuristic: a
    // token smuggled into storage should fail HERE, and a new key on this
    // surface should be a deliberate decision, not a silent one.
    expect(
      await page.evaluate(() =>
        [window.localStorage, window.sessionStorage].flatMap((store) =>
          Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ""}`),
        ),
      ),
    ).toEqual(["sambung.lang=en"]);
  });

  test("logging out ends the session, and a protected route bounces again", async ({
    page,
  }) => {
    await page.goto("/app/calendar");

    // Log out through the account menu in the top bar (ADR-0037) - the only
    // place the app offers it.
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("button", { name: "Log out" }).click();
    await page.waitForURL((url) => url.pathname === "/login");

    // The session is really gone: a fresh document load of a protected route
    // finds no token in memory AND no usable refresh cookie, so the guard
    // bounces it exactly like a stranger's.
    await page.goto("/app/reservations");
    await page.waitForURL((url) => url.pathname === "/login");
    expect(new URL(page.url()).searchParams.get("next")).toBe(
      "/app/reservations",
    );
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("visiting /login while signed in redirects to the dashboard", async ({
    page,
  }) => {
    // /login's own beforeLoad calls ensureSession(), so the live refresh cookie
    // is enough - an account holder never sees the form. /app then redirects on
    // to the calendar (the dashboard home).
    await page.goto("/login");

    await page.waitForURL("**/app/calendar");
    await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  });
});

test.describe("dashboard session: the workspace switch", () => {
  // The seeded staff account holds TWO seats (#154, ADR-0034): staff at Bali
  // Breeze (assigned to Seminyak only) and staff at Ubud Retreats. The default
  // seat is deterministic - owners first, then oldest, then ascending tenant id -
  // and Bali Breeze's id sorts first, so this session starts there.
  test.use({ storageState: STAFF_STATE });

  test("switching workspace resets the data view to the other tenant", async ({
    page,
  }) => {
    await page.goto("/app/properties");

    // Seat 1: Bali Breeze, scoped to the one assigned property.
    await expect(page.getByText("Seminyak Beach Villa")).toBeVisible();
    await expect(page.getByText("Ubud Jungle Villa")).toHaveCount(0);

    // The switcher lives at the top of the sidebar. Only rendered because this
    // account holds more than one seat.
    const workspace = page.getByLabel("Workspace");

    // Hold the post-switch refetch OPEN. Without this, the interesting window -
    // the moment between "the session is now Ubud" and "Ubud's rows have
    // arrived" - is too short to observe, and every auto-retrying matcher simply
    // converges on the same end state whether the switcher RESETS the cache or
    // merely INVALIDATES it. `reset` drops the data (loading state); `invalidate`
    // keeps rendering the previous tenant's rows while it refetches - which is
    // exactly the failure ADR-0034 and workspace-switcher.tsx exist to prevent,
    // so it must be the thing this test can actually see.
    await page.route("**/api/properties", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });

    const switched = page.waitForResponse(
      (res) => res.url().includes("/api/auth/session") && res.status() === 200,
    );
    await workspace.selectOption({ label: "Ubud Retreats" });
    await switched;

    // The header already reflects the new seat (the session swap and the cache
    // drop happen in one commit), so this is the deterministic anchor for the
    // sample below - not a wait for the data.
    await expect(
      workspace.getByRole("option", { name: "Ubud Retreats", selected: true }),
    ).toHaveCount(1);

    // ONE non-retrying sample, taken while Ubud's rows are still in flight.
    // Deliberately `evaluate` rather than a matcher: `toHaveCount(0)` would
    // retry until the refetch landed and pass under BOTH implementations
    // (measured - it does), which would make this assertion decorative.
    expect(
      await page.evaluate(() =>
        document.body.innerText.includes("Seminyak Beach Villa"),
      ),
    ).toBe(false);

    // Seat 2's end state, once the held refetch lands: a DIFFERENT owner's
    // tenant, showing that tenant's property and not the first one's.
    await expect(page.getByText("Ubud Jungle Villa")).toBeVisible();
    await expect(page.getByText("Seminyak Beach Villa")).toHaveCount(0);
  });
});
