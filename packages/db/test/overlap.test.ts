import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/index";

// Each test maps to one decision in the no_overlap constraint (db-design §4.3):
//   - overlap rejected / different-unit allowed  → the "unit_id WITH =" part
//   - changeover allowed                          → the "[)" half-open bound
//   - cancelled doesn't block / pending blocks    → the "WHERE status IN (...)"

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

let tenantId: string;
let propertyId: string;

async function makeUnit(name = "Unit") {
  const unit = await prisma.unit.create({
    data: { tenantId, propertyId, name, basePriceIdr: 500_000n },
  });
  return unit.id;
}

function book(
  unitId: string,
  status: "pending_payment" | "confirmed" | "cancelled" | "expired",
  from: string,
  to: string,
) {
  return prisma.booking.create({
    data: {
      tenantId,
      unitId,
      source: "direct",
      status,
      checkIn: d(from),
      checkOut: d(to),
    },
  });
}

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: "Test Tenant" } });
  tenantId = tenant.id;
  const property = await prisma.property.create({
    data: { tenantId, name: "Test Villa" },
  });
  propertyId = property.id;
});

afterAll(async () => {
  // Cascade removes the property, units, and bookings created under this tenant.
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("booking_no_overlap exclusion constraint", () => {
  it("rejects two overlapping occupying bookings on the same unit", async () => {
    const u = await makeUnit();
    await book(u, "confirmed", "2026-07-10", "2026-07-13");
    await expect(
      book(u, "confirmed", "2026-07-12", "2026-07-15"),
    ).rejects.toThrow(/exclusion|no_overlap|23P01/i);
  });

  it("allows a changeover: [10,13) and [13,16) do not overlap (half-open)", async () => {
    const u = await makeUnit();
    await book(u, "confirmed", "2026-07-10", "2026-07-13");
    await expect(
      book(u, "confirmed", "2026-07-13", "2026-07-16"),
    ).resolves.toBeTruthy();
  });

  it("allows the same dates on a different unit", async () => {
    const a = await makeUnit("A");
    const b = await makeUnit("B");
    await book(a, "confirmed", "2026-07-10", "2026-07-13");
    await expect(
      book(b, "confirmed", "2026-07-10", "2026-07-13"),
    ).resolves.toBeTruthy();
  });

  it("does not let a cancelled booking block its dates", async () => {
    const u = await makeUnit();
    await book(u, "cancelled", "2026-07-10", "2026-07-13");
    await expect(
      book(u, "confirmed", "2026-07-10", "2026-07-13"),
    ).resolves.toBeTruthy();
  });

  it("treats a pending_payment hold as occupying", async () => {
    const u = await makeUnit();
    await book(u, "pending_payment", "2026-07-10", "2026-07-13");
    await expect(
      book(u, "confirmed", "2026-07-12", "2026-07-15"),
    ).rejects.toThrow(/exclusion|no_overlap|23P01/i);
  });
});

describe("check constraints", () => {
  it("rejects an inverted stay (check_out <= check_in)", async () => {
    const u = await makeUnit();
    await expect(
      book(u, "confirmed", "2026-07-13", "2026-07-10"),
    ).rejects.toThrow(/check|stay_nonempty|23514/i);
  });
});
