import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/index";

// Each test maps to one composite FK from the tenant_consistency_fks migration
// (db-design §4.5, issue #40): a child row whose denormalized tenant_id
// disagrees with its parent chain must be rejected by the DB itself (23503),
// not merely by app code. Without these FKs the failure mode is silent: under
// RLS the row becomes visible to the WRONG tenant.

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

let tenantA: string;
let tenantB: string;
let propertyA: string;
let unitA: string;

beforeAll(async () => {
  const a = await prisma.tenant.create({ data: { name: "Tenant A (fk test)" } });
  const b = await prisma.tenant.create({ data: { name: "Tenant B (fk test)" } });
  tenantA = a.id;
  tenantB = b.id;
  const property = await prisma.property.create({
    data: { tenantId: tenantA, name: "Villa A" },
  });
  propertyA = property.id;
  const unit = await prisma.unit.create({
    data: { tenantId: tenantA, propertyId: propertyA, name: "Unit A", basePriceIdr: 500_000n },
  });
  unitA = unit.id;
});

afterAll(async () => {
  // Cascade removes properties, units, and bookings created under each tenant.
  await prisma.tenant.delete({ where: { id: tenantA } }).catch(() => {});
  await prisma.tenant.delete({ where: { id: tenantB } }).catch(() => {});
  await prisma.$disconnect();
});

describe("tenant-consistency composite FKs", () => {
  it("rejects a booking whose tenant_id differs from its unit's tenant", async () => {
    await expect(
      prisma.booking.create({
        data: {
          tenantId: tenantB, // wrong on purpose: unitA belongs to tenant A
          unitId: unitA,
          source: "direct",
          status: "confirmed",
          checkIn: d("2026-08-10"),
          checkOut: d("2026-08-13"),
        },
      }),
    ).rejects.toThrow(/booking_unit_tenant_fk|foreign key|23503/i);
  });

  it("rejects a unit whose tenant_id differs from its property's tenant", async () => {
    await expect(
      prisma.unit.create({
        data: {
          tenantId: tenantB, // wrong on purpose: propertyA belongs to tenant A
          propertyId: propertyA,
          name: "Rogue Unit",
          basePriceIdr: 1n,
        },
      }),
    ).rejects.toThrow(/unit_property_tenant_fk|foreign key|23503/i);
  });

  it("rejects a channel connection whose tenant_id differs from its unit's tenant", async () => {
    await expect(
      prisma.channelConnection.create({
        data: {
          tenantId: tenantB, // wrong on purpose: unitA belongs to tenant A
          unitId: unitA,
          channel: "airbnb",
          importIcalUrl: "https://example.com/cal.ics",
        },
      }),
    ).rejects.toThrow(/channel_connection_unit_tenant_fk|foreign key|23503/i);
  });

  it("control: consistent tenant_id inserts still work end-to-end", async () => {
    await expect(
      prisma.booking.create({
        data: {
          tenantId: tenantA,
          unitId: unitA,
          source: "direct",
          status: "confirmed",
          checkIn: d("2026-08-10"),
          checkOut: d("2026-08-13"),
        },
      }),
    ).resolves.toBeTruthy();
  });
});
