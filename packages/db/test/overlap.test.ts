import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../src/index";
import { booking, property, tenant, unit } from "../src/schema";
import { expectDbError } from "./helpers";

// Each test maps to one decision in the booking_no_overlap constraint
// (db-design §4.3):
//   - overlap rejected / different-unit allowed  → the "unit_id WITH =" part
//   - changeover allowed                          → the "[)" half-open bound
//   - cancelled doesn't block / pending blocks    → the "WHERE status IN (...)"

let tenantId: string;
let propertyId: string;

// Names are distinct per call because unit_property_name_uniq (ADR-0001) now
// forbids two units sharing a name under one property - which is the whole
// point of that constraint: these fixtures are exactly the "several
// indistinguishable rooms" an owner would otherwise create.
let unitSeq = 0;
async function makeUnit(name = `Unit ${++unitSeq}`) {
  const [row] = await db
    .insert(unit)
    .values({ tenantId, propertyId, name, basePriceIdr: 500_000n })
    .returning({ id: unit.id });
  return row.id;
}

function book(
  unitId: string,
  status: "pending_payment" | "confirmed" | "cancelled" | "expired",
  from: string,
  to: string,
) {
  return db.insert(booking).values({
    tenantId,
    unitId,
    source: "direct",
    status,
    checkIn: from,
    checkOut: to,
  });
}

beforeAll(async () => {
  const [t] = await db
    .insert(tenant)
    .values({ name: "Test Tenant" })
    .returning({ id: tenant.id });
  tenantId = t.id;
  const [p] = await db
    .insert(property)
    .values({ tenantId, name: "Test Villa" })
    .returning({ id: property.id });
  propertyId = p.id;
});

afterAll(async () => {
  // Cascade removes the property, units, and bookings created under this tenant.
  await db.delete(tenant).where(eq(tenant.id, tenantId));
  await closeDb();
});

describe("booking_no_overlap exclusion constraint", () => {
  it("rejects two overlapping occupying bookings on the same unit", async () => {
    const u = await makeUnit();
    await book(u, "confirmed", "2026-07-10", "2026-07-13");
    await expectDbError(
      book(u, "confirmed", "2026-07-12", "2026-07-15"),
      "23P01",
      "booking_no_overlap",
    );
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
    await expectDbError(
      book(u, "confirmed", "2026-07-12", "2026-07-15"),
      "23P01",
      "booking_no_overlap",
    );
  });
});

describe("check constraints", () => {
  it("rejects an inverted stay (check_out <= check_in)", async () => {
    const u = await makeUnit();
    await expectDbError(
      book(u, "confirmed", "2026-07-13", "2026-07-10"),
      "23514",
      "booking_stay_nonempty",
    );
  });
});
