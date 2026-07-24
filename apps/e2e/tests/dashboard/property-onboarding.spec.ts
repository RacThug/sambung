import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "../../fixtures/test";
import { OWNER_EMAIL } from "../../setup/e2e-config";
import { uniqueName } from "../../lib/helpers";

/**
 * Flow 2 - an owner onboards a property from nothing to publishable, then the
 * public page it produces (#169, umbrella #166). PROP-1/2/3 + AUTH-1.
 *
 * This flow registers its OWN owner + tenant at runtime (a unique email), so it
 * is fully isolated from the seed and from every other test - it writes no
 * Baseline row. Two consequences shape the setup:
 *
 *  - It must start WITHOUT a session. The dashboard project supplies the owner's
 *    storageState by default, but /register's already-authed guard would bounce
 *    a signed-in visitor straight to /app (router.tsx). Clear the state so each
 *    test genuinely starts as a stranger and drives the real signup form.
 *  - The photo upload is real: `setInputFiles` on the gallery input drives the
 *    app's presign -> PUT-to-Garage -> PATCH round-trip, the same path an owner's
 *    file picker takes. Garage is up in docker, and its bucket CORS names no
 *    origin (#182) - so this flow uploads from whatever port its lane serves on.
 */
test.use({ storageState: { cookies: [], origins: [] } });

// >= 8 chars (registerRequestSchema). Dev/e2e only - guards a disposable tenant.
const OWNER_PASSWORD = "sambung-e2e-owner";

/**
 * A valid 1x1 PNG, in memory - a real image so the presigned PUT and the <img>
 * render are genuine, without committing a binary fixture. `setInputFiles`
 * accepts the buffer directly, and the browser reports `mimeType` as `file.type`,
 * which is what the client pre-check and the presign validate.
 */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

/** Register a brand-new owner + tenant and land on the dashboard. Returns the
 *  email so a caller could assert on it; the identity is unique per call. */
async function registerFreshOwner(page: Page): Promise<string> {
  const email = `owner-${randomUUID().slice(0, 12)}@e2e.test`;
  await page.goto("/register");
  await page.getByLabel("Business name").fill(uniqueName("E2E Villas"));
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  // Signup creates the tenant + owner and starts the session in one step, then
  // lands on the calendar (page-spec §3.4) - which is also the "did it work" gate.
  await page.waitForURL("**/app/calendar");
  return email;
}

/** Create a property from the inventory home and land on its workbench. */
async function createProperty(page: Page, name: string): Promise<void> {
  await page.goto("/app/properties");
  // A fresh owner's list is empty, so the only "New property" is the empty-state
  // call to action.
  await page.getByRole("button", { name: "New property" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  // Create navigates straight to the property workbench (/app/properties/:id).
  await page.waitForURL(/\/app\/properties\/[0-9a-f-]{36}$/);
}

test.describe("owner onboards a property to publishable", () => {
  test("register -> property -> priced unit -> photo -> Ready to publish -> public page", async ({
    page,
  }) => {
    const propertyName = uniqueName("Ubud Retreat");
    const unitName = uniqueName("Garden Room");

    await registerFreshOwner(page);
    await createProperty(page, propertyName);

    // --- add a priced unit (price / max guests / min-stay) in the inline table ---
    await page.getByLabel("New unit name").fill(unitName);
    await page.getByLabel("New unit price per night in rupiah").fill("1500000");
    await page.getByLabel("New unit maximum guests").fill("4");
    await page.getByLabel("New unit minimum stay in nights").fill("2");
    await page.getByRole("button", { name: "Add unit" }).click();
    // The saved unit appears as its own table row; the add row resets to empty.
    await expect(page.getByRole("cell", { name: unitName })).toBeVisible();

    // --- upload a real photo: setInputFiles drives presign -> PUT to Garage ->
    // PATCH the gallery, exactly as an owner's file picker does. The button is
    // disabled until the gallery cap loads; we drive the hidden input directly,
    // which is the element the picker opens anyway. ---
    await page.getByLabel("Choose photos").setInputFiles({
      name: "villa.png",
      mimeType: "image/png",
      buffer: PNG_1x1,
    });
    // The grid only renders a photo the PATCH returned, so the thumbnail
    // appearing is proof the whole presign -> Garage -> save round-trip landed.
    await expect(
      page.getByRole("img", { name: `Photo 1 of ${propertyName}` }),
    ).toBeVisible();

    // The property's public address is on the workbench; grab it before we
    // navigate away (it's the only /p/ link on the page).
    const publicHref = await page
      .getByRole("link", { name: /\/p\// })
      .getAttribute("href");
    expect(publicHref).toBeTruthy();

    // --- with a photo AND a priced unit, the property is publishable (PROP-1) ---
    await page.goto("/app/properties");
    await expect(page.getByRole("link", { name: propertyName })).toContainText(
      "Ready to publish",
    );

    // --- the public page it produced shows the unit + gallery (PROP-1/2, CAL-2) ---
    await page.goto(publicHref!);
    await expect(
      page.getByRole("heading", { name: propertyName, level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(unitName)).toBeVisible();
    await expect(
      page.getByRole("img", { name: `${propertyName} - main photo` }),
    ).toBeVisible();
  });

  test("a property with no photo and no priced unit reads as incomplete", async ({
    page,
  }) => {
    const propertyName = uniqueName("Sanur Bungalow");

    await registerFreshOwner(page);
    await createProperty(page, propertyName);

    // The workbench leads with the incomplete nudge (ADR-0004: the page is live
    // but not worth sharing yet).
    await expect(
      page.getByText(
        "The public page is live, but incomplete - it needs at least one photo and one unit with a price before it's worth sharing.",
      ),
    ).toBeVisible();

    // And the inventory list states exactly what's missing (PROP-1).
    await page.goto("/app/properties");
    await expect(page.getByRole("link", { name: propertyName })).toContainText(
      "Incomplete - needs a photo and a priced unit",
    );
  });

  test("the Verified badge tracks the license/NIB field", async ({ page }) => {
    const propertyName = uniqueName("Legian Loft");

    await registerFreshOwner(page);
    await createProperty(page, propertyName);

    const license = page.getByLabel("License number (NIB)");
    await expect(license).toBeVisible();

    // A fresh property has no licence on file, so nothing is verified (PROP-3).
    await expect(page.getByText("Verified")).toHaveCount(0);

    // Setting the licence flips it - the live preview shows the badge...
    await license.fill("NIB-9120000123456");
    await expect(page.getByText("Verified")).toHaveCount(1);

    // ...and clearing it takes the badge away again: the badge tracks the field.
    await license.fill("");
    await expect(page.getByText("Verified")).toHaveCount(0);

    // It is the server-derived `verified`, not just a client preview: save it,
    // reload, and the badge is still there in the workbench header.
    await license.fill("NIB-9120000123456");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.getByText("Saved")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Verified").first()).toBeVisible();
  });

  test("registering an email that already exists is refused (AUTH-1)", async ({
    page,
  }) => {
    // A read-only scenario: it uses the seeded owner's address and creates
    // nothing. Signup must refuse a taken email rather than clobber the account.
    await page.goto("/register");
    await page.getByLabel("Business name").fill(uniqueName("Someone Else"));
    await page.getByLabel("Email").fill(OWNER_EMAIL);
    await page.getByLabel("Password").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();

    // The 409 is rendered as the email field's error (api-spec §3.1, #82).
    await expect(page.getByText("Email already registered")).toBeVisible();
    // And we stay on the signup form - nothing was created, no redirect to /app.
    await expect(page).toHaveURL(/\/register/);
  });
});
