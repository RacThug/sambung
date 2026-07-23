import { test, expect } from "../../fixtures/test";
import { STAFF_STATE } from "../../setup/e2e-config";

/**
 * Dashboard RBAC - property-scoped access for staff (#57, ADR-0032). This spec
 * runs as STAFF, overriding the dashboard project's owner storageState with the
 * staff session the setup project already produced.
 *
 * The seed puts staff@balibreeze.test on Bali Breeze assigned to Seminyak ONLY
 * (Canggu belongs to the same tenant but is unassigned). Scoping is enforced by
 * RLS, so an unassigned property isn't merely unlinked - it isn't in the list at
 * all - and creating a property is an owner-only verb.
 */
test.use({ storageState: STAFF_STATE });

test.describe("dashboard RBAC: staff property scoping", () => {
  test("staff sees only assigned properties and cannot create one", async ({
    page,
  }) => {
    await page.goto("/app/properties");

    // Assigned -> visible. (Asserted first, so the list has loaded before we
    // assert the absence below.)
    await expect(page.getByText("Seminyak Beach Villa")).toBeVisible();

    // Same tenant, NOT assigned -> hidden by RLS, not just missing a link.
    await expect(page.getByText("Canggu Surf House")).toHaveCount(0);

    // Create is an owner-only verb -> staff never sees the affordance.
    await expect(
      page.getByRole("button", { name: "New property" }),
    ).toHaveCount(0);
  });
});
