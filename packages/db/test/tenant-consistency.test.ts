import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { closeDb, db } from "../src/index";
import { booking, channelConnection, property, tenant, unit } from "../src/schema";
import { expectDbError, testSlug } from "./helpers";

// Each test maps to one composite FK from the schema (db-design §4.5, #40):
// a child row whose denormalized tenant_id disagrees with its parent chain
// must be rejected by the DB itself (23503), not merely by app code. Without
// these FKs the failure mode is silent: under RLS the row becomes visible to
// the WRONG tenant.

let tenantA: string;
let tenantB: string;
let propertyA: string;
let unitA: string;

beforeAll(async () => {
  const rows = await db
    .insert(tenant)
    .values([{ name: "Tenant A (fk test)" }, { name: "Tenant B (fk test)" }])
    .returning({ id: tenant.id });
  tenantA = rows[0].id;
  tenantB = rows[1].id;
  const [p] = await db
    .insert(property)
    .values({ tenantId: tenantA, name: "Villa A", slug: testSlug() })
    .returning({ id: property.id });
  propertyA = p.id;
  const [u] = await db
    .insert(unit)
    .values({
      tenantId: tenantA,
      propertyId: propertyA,
      name: "Unit A",
      basePriceIdr: 500_000n,
    })
    .returning({ id: unit.id });
  unitA = u.id;
});

afterAll(async () => {
  // Cascade removes properties, units, and bookings created under each tenant.
  await db.delete(tenant).where(inArray(tenant.id, [tenantA, tenantB]));
  await closeDb();
});

describe("tenant-consistency composite FKs", () => {
  it("rejects a booking whose tenant_id differs from its unit's tenant", async () => {
    await expectDbError(
      db.insert(booking).values({
        tenantId: tenantB, // wrong on purpose: unitA belongs to tenant A
        unitId: unitA,
        source: "direct",
        status: "confirmed",
        checkIn: "2026-08-10",
        checkOut: "2026-08-13",
      }),
      "23503",
      "booking_unit_tenant_fk",
    );
  });

  it("rejects a unit whose tenant_id differs from its property's tenant", async () => {
    await expectDbError(
      db.insert(unit).values({
        tenantId: tenantB, // wrong on purpose: propertyA belongs to tenant A
        propertyId: propertyA,
        name: "Rogue Unit",
        basePriceIdr: 1n,
      }),
      "23503",
      "unit_property_tenant_fk",
    );
  });

  it("rejects a channel connection whose tenant_id differs from its unit's tenant", async () => {
    await expectDbError(
      db.insert(channelConnection).values({
        tenantId: tenantB, // wrong on purpose: unitA belongs to tenant A
        unitId: unitA,
        channel: "airbnb",
        importIcalUrl: "https://example.com/cal.ics",
      }),
      "23503",
      "channel_connection_unit_tenant_fk",
    );
  });

  it("rejects flipping an existing booking's tenant_id to another tenant (UPDATE path)", async () => {
    const [b] = await db
      .insert(booking)
      .values({
        tenantId: tenantA,
        unitId: unitA,
        source: "direct",
        status: "cancelled", // cancelled: exempt from no_overlap, still FK-checked
        checkIn: "2026-09-01",
        checkOut: "2026-09-03",
      })
      .returning({ id: booking.id });
    await expectDbError(
      db.update(booking).set({ tenantId: tenantB }).where(eq(booking.id, b.id)),
      "23503",
      "booking_unit_tenant_fk",
    );
  });

  it("control: consistent tenant_id inserts still work end-to-end", async () => {
    await expect(
      db.insert(booking).values({
        tenantId: tenantA,
        unitId: unitA,
        source: "direct",
        status: "confirmed",
        checkIn: "2026-08-10",
        checkOut: "2026-08-13",
      }),
    ).resolves.toBeTruthy();
  });
});
