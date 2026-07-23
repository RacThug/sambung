import { test as setup, expect } from "./test";
import {
  DEMO_PASSWORD,
  OWNER_EMAIL,
  OWNER_STATE,
  STAFF_EMAIL,
  STAFF_STATE,
} from "../setup/e2e-config";
import type { Page } from "@playwright/test";

/**
 * The auth-state setup (blueprint Q5). Runs as a `setup` project that every
 * dashboard project depends on, so a signed-in session is prepared ONCE and
 * reused - no test re-drives the login form.
 *
 * It works because of Sambung's auth shape: the access token lives only in
 * memory, but the refresh token is an httpOnly cookie. `storageState` snapshots
 * cookies, so a fresh context that loads with that cookie hits `ensureSession()`
 * -> `refreshSession()` and is signed in again (architecture §4.4). We log in
 * through the REAL /login UI (this is the one place the login flow is exercised)
 * and assert a signed-in-only element BEFORE saving - so a broken assumption
 * fails here, loudly, not silently in every downstream test.
 *
 * Both roles are produced from one helper: owner (Journey 2 uses it) and staff
 * (proves the pattern scales, and pre-wires the property-scoped RBAC tests that
 * come next).
 */
async function signIn(
  page: Page,
  email: string,
  password: string,
  statePath: string,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // /app redirects to /app/calendar on success; a failed login would sit on
  // /login, so this wait is itself the "did we actually authenticate" guard.
  await page.waitForURL("**/app/calendar");
  await expect(page.getByRole("link", { name: "Calendar" })).toBeVisible();

  await page.context().storageState({ path: statePath });
}

setup("authenticate as owner", async ({ page }) => {
  await signIn(page, OWNER_EMAIL, DEMO_PASSWORD, OWNER_STATE);
});

setup("authenticate as staff", async ({ page }) => {
  await signIn(page, STAFF_EMAIL, DEMO_PASSWORD, STAFF_STATE);
});
