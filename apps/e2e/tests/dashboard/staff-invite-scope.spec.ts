import { randomUUID } from "node:crypto";
import { test, expect } from "../../fixtures/test";
import {
  KNOWN_INVITE_EMAIL,
  KNOWN_INVITE_TOKEN,
  OWNER_STATE,
  STAFF_STATE,
} from "../../setup/e2e-config";

/**
 * Flow 5 - the staff lifecycle end to end (#172, #57, ADR-0032/0033).
 *
 * An owner invites a colleague, the colleague accepts the emailed link and lands
 * scoped to exactly the properties they were granted, and the enforcement holds
 * both ways: an unassigned property is a 404 by direct id (RLS makes it invisible,
 * not merely unlinked - boss fight #5), and the owner-only verbs are hidden and
 * refused. A dead link says so.
 *
 * The one thing only an e2e can prove here is scenario 3: RLS as a REAL signed-in
 * session, reached by pasting an id into the URL. api specs prove the token
 * hashing, the single-use race, and the policy correctness; this proves the id a
 * scoped user cannot see returns 404, not 403, through the actual dashboard.
 *
 * Data: the accept scenario consumes the seeded known-token invite (#167) - safe
 * because it is single-use within one run and the lane DB is reseeded each run.
 * The owner scenario invites a run-unique email so re-runs never collide, and the
 * scope scenarios only READ the seeded staff@balibreeze.test / its assignments.
 */

/** Canggu belongs to Bali Breeze (T1) but is NOT assigned to staff@balibreeze.test,
 *  so a scoped-staff session cannot see it. Fixed seed id, mirrored here rather than
 *  imported (importing the seed would run it) - source of truth is P_CANGGU in
 *  packages/db/scripts/seed.ts. If it drifts, scenario 3 fails loudly (a 200, not a
 *  404). */
const CANGGU_PROPERTY_ID = "aaaaaaaa-0000-0000-0000-000000000002";

/** A signed-out browser. The public /invite accept flow must NOT arrive already
 *  authenticated - someone opening an invite is, by definition, not yet this
 *  account (the route has no already-authed redirect on purpose, router.tsx). */
const SIGNED_OUT = { cookies: [], origins: [] };

test.describe("Flow 5 - owner invites staff", () => {
  test.use({ storageState: OWNER_STATE });

  // Scenario 1 [AUTH-2]: the owner sends an invite scoped to a property and sees
  // it land in the pending list, carrying that property.
  test("owner invites an email scoped to a property and it appears pending", async ({
    page,
  }) => {
    // Run-unique so a re-run (or a parallel worker) never collides on "already
    // invited to this team". No account exists at this address -> create-account
    // path, and the invite is accepted-by-nobody, so it stays pending.
    const invitee = `e2e-invite-${randomUUID().slice(0, 8)}@balibreeze.test`;

    await page.goto("/app/settings");

    // Team management is owner-only and rendered as such (#57).
    await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();

    await page.getByLabel("Email address").fill(invitee);
    // Grant one property; the invite must grant access to something.
    await page
      .getByRole("checkbox", { name: "Seminyak Beach Villa" })
      .check();
    await page.getByRole("button", { name: "Send invite" }).click();

    // It shows up under Pending invites, scoped to the property we granted - the
    // owner's proof the offer exists and to what. Scoped to the row so the
    // "Invite emailed to <email>" confirmation line doesn't create ambiguity.
    await expect(
      page.getByRole("heading", { name: "Pending invites" }),
    ).toBeVisible();
    const pendingRow = page.getByRole("listitem").filter({ hasText: invitee });
    await expect(pendingRow).toBeVisible();
    await expect(pendingRow).toContainText("Seminyak Beach Villa");
  });
});

test.describe("Flow 5 - accept an invite", () => {
  // The accept flow is public and must start SIGNED OUT, so the invitee becomes
  // the account they accept as, not whoever the browser last authenticated as.
  test.use({ storageState: SIGNED_OUT });

  // Scenario 2 [AUTH-2]: the seeded known-token invite -> preview -> set a
  // password -> land in the dashboard as scoped staff.
  test("a seeded invite previews, accepts, and lands as scoped staff", async ({
    page,
  }) => {
    await page.goto(`/invite/${KNOWN_INVITE_TOKEN}`);

    // The preview answers "what is this?" before asking for anything: who invited
    // you (the tenant), the address it is bound to, and what you'll manage.
    await expect(
      page.getByRole("heading", { name: "Join Bali Breeze Villas" }),
    ).toBeVisible();
    await expect(page.getByText(KNOWN_INVITE_EMAIL)).toBeVisible();
    await expect(page.getByText("You'll be able to manage")).toBeVisible();
    await expect(page.getByText("Seminyak Beach Villa")).toBeVisible();

    // No account at this address -> create mode: the field SETS a password.
    await page.getByLabel("Password").fill("e2e-newstaff-pw1");
    await page.getByRole("button", { name: "Create account" }).click();

    // Accepting IS signing in: straight into the dashboard (page-spec §3.4). /app
    // redirects to the calendar, so this wait is itself the "did we authenticate"
    // guard.
    await page.waitForURL("**/app/calendar");
    await expect(page.getByRole("link", { name: "Calendar" })).toBeVisible();

    // We are the accepted account - the account menu carries its email.
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByText(KNOWN_INVITE_EMAIL)).toBeVisible();

    // And we are SCOPED: the grant was Seminyak only, so the properties list shows
    // it and not Canggu (same tenant, unassigned -> invisible by RLS), and there
    // is no owner-only "New property" affordance.
    await page.goto("/app/properties");
    await expect(page.getByText("Seminyak Beach Villa")).toBeVisible();
    await expect(page.getByText("Canggu Surf House")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "New property" }),
    ).toHaveCount(0);
  });

  // Scenario 5 [AUTH-2]: a garbage token resolves to no invite -> the
  // not-acceptable state, deliberately distinct copy from a spent one.
  test("a dead token shows the not-acceptable state", async ({ page }) => {
    await page.goto(`/invite/${randomUUID()}-not-a-real-token`);

    await expect(
      page.getByRole("heading", { name: "This invite can't be used" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to sign in" })).toBeVisible();
    // It never renders the accept form - there is nothing to accept.
    await expect(
      page.getByRole("button", { name: "Create account" }),
    ).toHaveCount(0);
  });
});

test.describe("Flow 5 - scoped access as staff", () => {
  // These run as the seeded staff@balibreeze.test (assigned to Seminyak only),
  // overriding the dashboard project's owner default (staff-scope.spec pattern).
  test.use({ storageState: STAFF_STATE });

  // Scenario 3 [AUTH-3, BF#5]: the id a scoped user cannot see returns 404, NOT
  // 403. This is the value only an e2e can add - RLS as a real session, by id.
  test("an unassigned property is 404 by direct id, not 403", async ({
    page,
  }) => {
    // Assert the WIRE, not just the rendered copy: RLS scopes the row out, so the
    // read is a 404 (it isn't there), never a 403 (which would leak that it is).
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/properties/${CANGGU_PROPERTY_ID}`) &&
        response.request().method() === "GET",
    );
    await page.goto(`/app/properties/${CANGGU_PROPERTY_ID}`);
    const response = await responsePromise;
    expect(response.status()).toBe(404);

    // And the workbench renders "not found" rather than a permission wall. The
    // copy now covers both readings without confirming which - "doesn't exist, or
    // it isn't yours" - which is exactly the answer 404-over-403 exists to give
    // (divergence D5: it also stopped saying this for a mere network failure).
    await expect(
      page.getByText(/doesn.t exist, or it isn.t yours/i),
    ).toBeVisible();
  });

  // Scenario 4 [AUTH-3]: owner-only verbs are hidden from staff and the settings
  // write is not offered (the server refuses it regardless - @Roles('owner')).
  test("owner-only verbs are hidden: no create, no settings write", async ({
    page,
  }) => {
    // Creating a property is the owner's call (they decide the SHAPE of the
    // tenant), so staff never see the affordance.
    await page.goto("/app/properties");
    await expect(page.getByText("Seminyak Beach Villa")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New property" }),
    ).toHaveCount(0);

    // Settings is readable but not writable by staff: the gallery-cap form and the
    // Team invite form are replaced by read-only notes, not offered and refused.
    await page.goto("/app/settings");
    await expect(
      page.getByText("Only an account owner can change this."),
    ).toBeVisible();
    await expect(
      page.getByText(/Only an account owner can invite staff/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Send invite" }),
    ).toHaveCount(0);
  });
});
