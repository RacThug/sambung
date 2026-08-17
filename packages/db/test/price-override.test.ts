import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { closeDb, db } from "../src/index";
import { property, tenant, unit, unitPriceOverride } from "../src/schema";
import { expectDbError, testSlug } from "./helpers";

// Each test maps to one decision in migration 0017 (PRD-product P0-2):
//   - overlap rejected / different-unit allowed → "unit_id WITH =" in
//     price_override_no_overlap (the booking_no_overlap pattern)
//   - back-to-back seasons allowed              → the "[)" half-open bound
//   - the CHECKs                                → layer 2 of "rejected twice
//     over" (zod bypassed on purpose, the unit-bounds argument)
//   - cascade on unit delete                    → config, not ledger (ADR-0002
//     protects bookings; a price window has no history to protect)

let tenantId: string;
let propertyId: string;

let unitSeq = 0;
async function makeUnit(name = `Priced Unit ${++unitSeq}`) {
  const [row] = await db
    .insert(unit)
    .values({ tenantId, propertyId, name, basePriceIdr: 500_000n })
    .returning({ id: unit.id });
  return row.id;
}

function override(
  unitId: string,
  from: string,
  to: string,
  nightlyPriceIdr = 2_000_000n,
) {
  return db.insert(unitPriceOverride).values({
    tenantId,
    unitId,
    fromDate: from,
    toDate: to,
    nightlyPriceIdr,
  });
}

beforeAll(async () => {
  const [t] = await db
    .insert(tenant)
    .values({ name: "Tenant (price override)" })
    .returning({ id: tenant.id });
  tenantId = t.id;
  const [p] = await db
    .insert(property)
    .values({ tenantId, name: "Villa Seasons", slug: testSlug() })
    .returning({ id: property.id });
  propertyId = p.id;
});

afterAll(async () => {
  await db.delete(tenant).where(eq(tenant.id, tenantId));
  await closeDb();
});

describe("price_override_no_overlap exclusion constraint", () => {
  it("rejects two overlapping overrides on the same unit", async () => {
    const u = await makeUnit();
    await override(u, "2027-07-01", "2027-08-01");
    await expectDbError(
      override(u, "2027-07-15", "2027-09-01"),
      "23P01",
      "price_override_no_overlap",
    );
  });

  it("allows back-to-back seasons: [Jun,Jul) and [Jul,Aug) do not overlap (half-open)", async () => {
    const u = await makeUnit();
    await override(u, "2027-06-01", "2027-07-01");
    await expect(
      override(u, "2027-07-01", "2027-08-01"),
    ).resolves.toBeTruthy();
  });

  it("allows the same dates on a different unit", async () => {
    const a = await makeUnit("Season A");
    const b = await makeUnit("Season B");
    await override(a, "2027-12-20", "2028-01-05");
    await expect(
      override(b, "2027-12-20", "2028-01-05"),
    ).resolves.toBeTruthy();
  });
});

describe("price override CHECK constraints", () => {
  it("rejects an inverted range (to_date <= from_date)", async () => {
    const u = await makeUnit();
    await expectDbError(
      override(u, "2027-08-01", "2027-07-01"),
      "23514",
      "price_override_range_nonempty",
    );
  });

  // Floor is 1, not 0: a zero BASE price is a placeholder with a job
  // (publishable); a zero OVERRIDE would just make sellable nights free.
  it("rejects a zero nightly price", async () => {
    const u = await makeUnit();
    await expectDbError(
      override(u, "2027-07-01", "2027-08-01", 0n),
      "23514",
      "price_override_nightly_range",
    );
  });

  // The same cap as unit_base_price_max, so the #47 overflow argument holds for
  // every night of a stay, overridden or not.
  it("rejects a nightly price above the cap, accepts one exactly at it", async () => {
    const u = await makeUnit();
    await expectDbError(
      override(u, "2027-07-01", "2027-08-01", 1_000_000_001n),
      "23514",
      "price_override_nightly_range",
    );
    await expect(
      override(u, "2027-07-01", "2027-08-01", 1_000_000_000n),
    ).resolves.toBeTruthy();
  });
});

describe("overrides are config, not ledger", () => {
  it("deleting an unbooked unit cascades its overrides away", async () => {
    // ADR-0002 blocks deleting a unit with BOOKINGS; a unit with only price
    // config must still delete cleanly, taking the config with it - nothing
    // sold is rewritten, because a booking snapshots total_price_idr.
    const u = await makeUnit("Disposable");
    await override(u, "2027-07-01", "2027-08-01");
    await expect(
      db.delete(unit).where(inArray(unit.id, [u])),
    ).resolves.toBeTruthy();
    const rows = await db
      .select({ id: unitPriceOverride.id })
      .from(unitPriceOverride)
      .where(eq(unitPriceOverride.unitId, u));
    expect(rows).toEqual([]);
  });
});
