import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { closeDb, db } from "../src/index";
import { booking, payment, property, tenant, unit } from "../src/schema";
import { expectDbError } from "./helpers";

// Layer 2 of #45's "rejected twice over", and the enforcement half of ADR-0002.
//
// These connect as the OWNER role and write raw rows: zod, the DTOs and the
// service guard are all bypassed on purpose. That is the entire point. If zod
// works, a negative price NEVER reaches the CHECK through the API - so one HTTP
// request cannot prove both layers, and the only honest way to know the DB half
// holds is to attack it directly. Same argument as
// apps/api/src/properties/properties.spec.ts, which disables RLS to prove the
// repository's WHERE stands on its own.
//
// A CHECK firing in production would mean the boundary is broken, which is why
// none of these constraints is mapped in db-error.map.ts: they surface as 500s
// deliberately (ADR #80 - "a constraint nobody considered is a bug, not a 409").

let tenantA: string;
let propertyA: string;
let unitA: string;

beforeAll(async () => {
  const [t] = await db
    .insert(tenant)
    .values({ name: "Tenant (unit bounds)" })
    .returning({ id: tenant.id });
  tenantA = t.id;
  const [p] = await db
    .insert(property)
    .values({ tenantId: tenantA, name: "Villa Bounds" })
    .returning({ id: property.id });
  propertyA = p.id;
  const [u] = await db
    .insert(unit)
    .values({
      tenantId: tenantA,
      propertyId: propertyA,
      name: "Garden Room 1",
      basePriceIdr: 1_200_000n,
    })
    .returning({ id: unit.id });
  unitA = u.id;
});

afterAll(async () => {
  await db.delete(tenant).where(inArray(tenant.id, [tenantA]));
  await closeDb();
});

const validUnit = () => ({
  tenantId: tenantA,
  propertyId: propertyA,
  name: `Unit ${Math.random()}`,
  basePriceIdr: 500_000n,
});

describe("unit CHECK constraints (api-spec §4.6)", () => {
  it("rejects a negative price", async () => {
    await expectDbError(
      db.insert(unit).values({ ...validUnit(), basePriceIdr: -1n }),
      "23514",
      "unit_base_price_nonneg",
    );
  });

  it("accepts a zero price - a placeholder is storable, just not sellable", async () => {
    await expect(
      db.insert(unit).values({ ...validUnit(), basePriceIdr: 0n }),
    ).resolves.toBeTruthy();
  });

  it("rejects maxGuests of zero", async () => {
    await expectDbError(
      db.insert(unit).values({ ...validUnit(), maxGuests: 0 }),
      "23514",
      "unit_max_guests_positive",
    );
  });

  it("rejects minStay below one", async () => {
    await expectDbError(
      db.insert(unit).values({ ...validUnit(), minStay: 0 }),
      "23514",
      "unit_min_stay_positive",
    );
  });

  it("rejects a price made negative by UPDATE, not just INSERT", async () => {
    await expectDbError(
      db
        .update(unit)
        .set({ basePriceIdr: -1n })
        .where(inArray(unit.id, [unitA])),
      "23514",
      "unit_base_price_nonneg",
    );
  });
});

describe("unit_property_name_uniq (ADR-0001)", () => {
  it("rejects a second unit with the same name under one property", async () => {
    await expectDbError(
      db.insert(unit).values({ ...validUnit(), name: "Garden Room 1" }),
      "23505",
      "unit_property_name_uniq",
    );
  });

  it("is case-sensitive, as decided", async () => {
    await expect(
      db.insert(unit).values({ ...validUnit(), name: "garden room 1" }),
    ).resolves.toBeTruthy();
  });

  it("scopes to the property - two properties may each have a Garden Room", async () => {
    const [p2] = await db
      .insert(property)
      .values({ tenantId: tenantA, name: "Villa Two" })
      .returning({ id: property.id });
    await expect(
      db.insert(unit).values({
        tenantId: tenantA,
        propertyId: p2.id,
        name: "Garden Room 1",
        basePriceIdr: 500_000n,
      }),
    ).resolves.toBeTruthy();
  });
});

// ADR-0002. The bug being locked out: before 0003 these FKs were CASCADE, so
// deleting a unit returned success and silently took its bookings - and their
// payment rows - with it.
describe("deleting inventory never destroys the ledger", () => {
  let bookedUnit: string;

  beforeAll(async () => {
    const [u] = await db
      .insert(unit)
      .values({ ...validUnit(), name: "Booked Room" })
      .returning({ id: unit.id });
    bookedUnit = u.id;
    const [b] = await db
      .insert(booking)
      .values({
        tenantId: tenantA,
        unitId: bookedUnit,
        source: "direct",
        // Past AND cancelled: invisible to the OLD "future occupying" guard,
        // and exactly the row whose payment must not evaporate.
        status: "cancelled",
        checkIn: "2020-01-01",
        checkOut: "2020-01-03",
      })
      .returning({ id: booking.id });
    await db
      .insert(payment)
      .values({ bookingId: b.id, provider: "midtrans", amountIdr: 1_000_000n });
  });

  it("refuses to delete a unit with a booking, however old or cancelled", async () => {
    await expectDbError(
      db.delete(unit).where(inArray(unit.id, [bookedUnit])),
      "23503",
      "booking_unit_id_unit_id_fk",
    );
  });

  it("refuses to delete the property above it - the cascade hits the same check", async () => {
    await expectDbError(
      db.delete(property).where(inArray(property.id, [propertyA])),
      "23503",
      "booking_unit_id_unit_id_fk",
    );
  });

  // The reason 0003 uses `no action` and not `restrict`: restrict fires
  // immediately and would break this, because closing an account legitimately
  // cascades tenant -> property -> unit -> booking. `no action` defers to
  // end-of-statement, by which time booking.tenant_id's own cascade has already
  // removed the rows. Deleting a tenant is what afterAll does in every db test,
  // so a regression here takes the whole suite down with it - deliberately.
  it("still lets a tenant be deleted, cascading the whole tree", async () => {
    const [t] = await db
      .insert(tenant)
      .values({ name: "Tenant (closure)" })
      .returning({ id: tenant.id });
    const [p] = await db
      .insert(property)
      .values({ tenantId: t.id, name: "Villa Closing" })
      .returning({ id: property.id });
    const [u] = await db
      .insert(unit)
      .values({
        tenantId: t.id,
        propertyId: p.id,
        name: "Room",
        basePriceIdr: 1n,
      })
      .returning({ id: unit.id });
    await db.insert(booking).values({
      tenantId: t.id,
      unitId: u.id,
      source: "direct",
      status: "confirmed",
      checkIn: "2020-02-01",
      checkOut: "2020-02-03",
    });

    await expect(
      db.delete(tenant).where(inArray(tenant.id, [t.id])),
    ).resolves.toBeTruthy();
  });
});
