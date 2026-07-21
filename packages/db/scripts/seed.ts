/**
 * Seed: 2 tenants, 3 properties, units, sample bookings, and one open sync
 * conflict - instant demo state.
 *
 * Idempotent: wipes all rows then re-inserts, inside one transaction, with fixed
 * UUIDs so demo links stay stable across runs. Dev/demo only.
 *
 * Run: pnpm --filter @sambung/db db:seed
 */
import "./load-env";
import { count, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { closeDb, db } from "../src/index";
import {
  DEMO_FREE_NIGHTS,
  DEMO_UNIT_MIN_STAY,
  demoDates,
  type DemoStay,
  type DemoUnitKey,
} from "./demo-dates";
import { uploadSeedPhotos } from "./seed-photos";
import {
  appUser,
  booking,
  channelConnection,
  payment,
  paymentEvent,
  property,
  syncConflict,
  tenant,
  unit,
  userProperty,
} from "../src/schema";

// Fixed IDs so re-seeding is stable and demo URLs don't change.
//
// Slugs are literal for the same reason, and written here rather than derived
// via slugifyName: this script inserts rows directly on the owner connection,
// bypassing the service that mints them, and a seed's whole job is to produce
// the SAME state every run. `/p/seminyak-beach-villa` is a demo link that gets
// pasted into a README - it must survive re-seeding (#46 AC).
const T1 = "11111111-1111-1111-1111-111111111111"; // Bali Breeze Villas
const T2 = "22222222-2222-2222-2222-222222222222"; // Ubud Retreats
const P_SEMINYAK = "aaaaaaaa-0000-0000-0000-000000000001";
const P_CANGGU = "aaaaaaaa-0000-0000-0000-000000000002";
const P_UBUD = "aaaaaaaa-0000-0000-0000-000000000003";
const U_VILLA = "bbbbbbbb-0000-0000-0000-000000000001";
const U_GARDEN = "bbbbbbbb-0000-0000-0000-000000000002";
const U_SURF = "bbbbbbbb-0000-0000-0000-000000000003";
const U_RIVER = "bbbbbbbb-0000-0000-0000-000000000004";
const CC_AIRBNB = "cccccccc-0000-0000-0000-000000000001";
const SC_DOUBLE_SELL = "dddddddd-0000-0000-0000-000000000001";

// bcrypt("sambung123", 12 rounds) - matches the auth service's BCRYPT_ROUNDS,
// so seeded owners can log into the dashboard. Precomputed constant: keeps the
// seed deterministic and this package free of a bcrypt dependency. Dev/demo
// only; the password is intentionally public.
const DEMO_PASSWORD = "sambung123";
const DEMO_PASSWORD_HASH =
  "$2b$12$l/JDRuTK3RV2ZPO5tKDPrOJ7DvutHzlXTbFqTUgwFrO4GI1HPts.y";

// Sample stays are anchored to TODAY, not to fixed calendar dates - see
// ./demo-dates.ts for why (short version: the picker hides the past and the
// dashboard opens on this month, so a stay seeded behind the presenter or a
// fortnight ahead of them is invisible, not just stale). Only the DATES move
// with time; the stable demo surface (ids, slugs, logins) stays fixed.
const D = demoDates(new Date());

/** Nightly rate per unit, integer rupiah (invariant #6). */
const PRICE: Record<DemoUnitKey, bigint> = {
  wholeVilla: 3_500_000n,
  gardenRoom: 1_200_000n,
  surfLoft: 950_000n,
  riverSuite: 2_100_000n,
};

/** Nights in a half-open stay. Both ends are midnight-anchored, so this is exact. */
const nights = ({ checkIn, checkOut }: DemoStay): bigint =>
  BigInt(
    (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) /
      86_400_000,
  );

/**
 * A stay's total, DERIVED rather than written down. The stays now move with the
 * calendar, and a hand-typed total silently stops matching nights x rate the
 * first time one changes length - the demo would show a price the product's own
 * quote endpoint disagrees with.
 */
const total = (stay: DemoStay, unit: DemoUnitKey): bigint =>
  nights(stay) * PRICE[unit];

async function main() {
  await db.transaction(async (tx) => {
    // --- wipe (FK-safe order) so the seed is idempotent ---
    await tx.delete(syncConflict);
    await tx.delete(paymentEvent);
    await tx.delete(payment);
    await tx.delete(booking);
    await tx.delete(channelConnection);
    await tx.delete(userProperty);
    await tx.delete(unit);
    await tx.delete(property);
    await tx.delete(appUser);
    await tx.delete(tenant);

    // --- tenants + owners ---
    await tx.insert(tenant).values([
      { id: T1, name: "Bali Breeze Villas" },
      { id: T2, name: "Ubud Retreats" },
    ]);
    await tx.insert(appUser).values([
      {
        tenantId: T1,
        email: "owner@balibreeze.test",
        passwordHash: DEMO_PASSWORD_HASH,
        role: "owner",
      },
      {
        tenantId: T2,
        email: "owner@ubudretreats.test",
        passwordHash: DEMO_PASSWORD_HASH,
        role: "owner",
      },
    ]);

    // --- properties (3) ---
    await tx.insert(property).values([
      {
        id: P_SEMINYAK,
        tenantId: T1,
        name: "Seminyak Beach Villa",
        slug: "seminyak-beach-villa",
        address: "Jl. Kayu Aya, Seminyak, Bali",
        latitude: -8.6905,
        longitude: 115.1656,
        description: "Two-bedroom villa steps from Seminyak beach.",
        licenseNo: "NIB-1234567890", // → "Verified" badge
      },
      {
        id: P_CANGGU,
        tenantId: T1,
        name: "Canggu Surf House",
        slug: "canggu-surf-house",
        address: "Jl. Pantai Batu Bolong, Canggu, Bali",
        latitude: -8.6478,
        longitude: 115.1385,
        description: "Surf-style loft a short walk from Batu Bolong.",
        // no licenseNo → no Verified badge (demonstrates the conditional badge)
        // A partial Deposit (30%) so checkout demonstrates deposit vs pay-in-full
        // (#52); the other properties keep the default 100%.
        depositPct: 30,
      },
      {
        id: P_UBUD,
        tenantId: T2,
        name: "Ubud Jungle Villa",
        slug: "ubud-jungle-villa",
        address: "Jl. Raya Tegallalang, Ubud, Bali",
        latitude: -8.4312,
        longitude: 115.2769,
        description: "Riverside suite overlooking the jungle.",
        licenseNo: "NIB-0987654321",
      },
    ]);

    // --- units (4) ---
    // `minStay` comes from DEMO_UNIT_MIN_STAY rather than a literal, so the
    // test that asserts "every seeded stay is at least its unit's minimum"
    // checks the number this row actually gets (#60).
    await tx.insert(unit).values([
      {
        id: U_VILLA,
        propertyId: P_SEMINYAK,
        tenantId: T1,
        name: "Whole Villa",
        basePriceIdr: PRICE.wholeVilla,
        maxGuests: 4,
        minStay: DEMO_UNIT_MIN_STAY.wholeVilla,
      },
      {
        id: U_GARDEN,
        propertyId: P_SEMINYAK,
        tenantId: T1,
        name: "Garden Room",
        basePriceIdr: PRICE.gardenRoom,
        maxGuests: 2,
        minStay: DEMO_UNIT_MIN_STAY.gardenRoom,
      },
      {
        id: U_SURF,
        propertyId: P_CANGGU,
        tenantId: T1,
        name: "Surf Loft",
        basePriceIdr: PRICE.surfLoft,
        maxGuests: 2,
        minStay: DEMO_UNIT_MIN_STAY.surfLoft,
      },
      {
        id: U_RIVER,
        propertyId: P_UBUD,
        tenantId: T2,
        name: "Riverside Suite",
        basePriceIdr: PRICE.riverSuite,
        maxGuests: 2,
        minStay: DEMO_UNIT_MIN_STAY.riverSuite,
      },
    ]);

    // --- a channel connection (Airbnb) on the Whole Villa ---
    await tx.insert(channelConnection).values({
      id: CC_AIRBNB,
      unitId: U_VILLA,
      tenantId: T1,
      channel: "airbnb",
      importIcalUrl: "https://www.airbnb.com/calendar/ical/EXAMPLE.ics",
      lastStatus: "ok",
      // Relative, like the conflict's timestamps below: a fixed date reads as
      // "last synced two years ago" at demo time. Half a cron cycle back, so the
      // panel looks like a feed that is genuinely being polled every 30 min.
      lastSyncedAt: new Date(Date.now() - 15 * 60_000),
    });

    // --- sample bookings (non-overlapping per unit; respects no_overlap) ---
    // Whole Villa: a direct booking + an OTA-imported one on different dates.
    const [directVilla] = await tx
      .insert(booking)
      .values({
        tenantId: T1,
        unitId: U_VILLA,
        source: "direct",
        status: "confirmed",
        checkIn: D.villaDirect.checkIn,
        checkOut: D.villaDirect.checkOut,
        guestName: "Wayan D.",
        guestPhone: "+62 812-0000-0001",
        guestEmail: "wayan@example.com",
        guestCount: 3,
        totalPriceIdr: total(D.villaDirect, "wholeVilla"),
      })
      .returning({ id: booking.id });

    await tx.insert(booking).values([
      {
        tenantId: T1,
        unitId: U_VILLA,
        source: "airbnb",
        status: "confirmed",
        checkIn: D.villaImported.checkIn,
        checkOut: D.villaImported.checkOut,
        guestName: "Airbnb guest",
        channelConnectionId: CC_AIRBNB,
        externalUid: "airbnb-evt-0001@airbnb.com", // idempotent re-sync key
      },
      // Garden Room: a live hold (pending_payment) that blocks those dates.
      {
        tenantId: T1,
        unitId: U_GARDEN,
        source: "direct",
        status: "pending_payment",
        checkIn: D.gardenHold.checkIn,
        checkOut: D.gardenHold.checkOut,
        guestName: "Komang S.",
        guestPhone: "+62 812-0000-0002",
        guestCount: 2,
        totalPriceIdr: total(D.gardenHold, "gardenRoom"),
        holdExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
      // Surf Loft: a manual maintenance block.
      {
        tenantId: T1,
        unitId: U_SURF,
        source: "manual_block",
        status: "confirmed",
        checkIn: D.surfBlock.checkIn,
        checkOut: D.surfBlock.checkOut,
        guestName: null,
      },
      // Riverside Suite (tenant 2): a direct confirmed booking.
      {
        tenantId: T2,
        unitId: U_RIVER,
        source: "direct",
        status: "confirmed",
        checkIn: D.riverDirect.checkIn,
        checkOut: D.riverDirect.checkOut,
        guestName: "Asian traveler",
        guestPhone: "+86 138-0000-0003",
        guestCount: 2,
        totalPriceIdr: total(D.riverDirect, "riverSuite"),
      },
    ]);

    // A paid payment for the Whole Villa direct booking.
    await tx.insert(payment).values({
      bookingId: directVilla.id,
      provider: "midtrans",
      providerRef: "SEED-ORDER-0001",
      amountIdr: total(D.villaDirect, "wholeVilla"),
      status: "paid",
    });

    // --- an open sync conflict (#38, ADR-0027) ---
    // A real-world double-sell: Airbnb sold nights on the Whole Villa that
    // "Wayan D." above has ALREADY booked direct and PAID for. The exclusion
    // constraint refused the import (as it should - the alternative is two guests
    // at one door), so it lands in the owner's inbox for a human to sort out.
    //
    // Seeded as a row rather than produced by a real import, because an import
    // needs a reachable https feed and the fetcher blocks localhost by design
    // (SSRF, ADR-0016) - so there is no way to generate one offline. What matters
    // for the demo is that everything AROUND it is real: the blocking booking
    // genuinely exists and genuinely overlaps, so `blockingBookings` on
    // GET /sync-conflicts derives it live through the same `daterange &&` the
    // constraint itself uses. The inbox shows a true picture, not a mock.
    //
    // Dates: `refusedImport` against `villaDirect` - a PARTIAL overlap on
    // purpose. Identical dates would hide the bug where the two ranges get
    // conflated; a partial one makes the inbox prove it shows both. The overlap
    // is asserted in test/demo-dates.test.ts, not just intended here.
    //
    // Timestamps are relative so the demo never looks stale: first seen two days
    // ago (it has been waiting), last seen one cron cycle ago (still being
    // re-detected every 30 min, and still refused).
    await tx.insert(syncConflict).values({
      id: SC_DOUBLE_SELL,
      tenantId: T1,
      channelConnectionId: CC_AIRBNB,
      unitId: U_VILLA,
      externalUid: "airbnb-evt-0002@airbnb.com",
      checkIn: D.refusedImport.checkIn,
      checkOut: D.refusedImport.checkOut,
      status: "open",
      firstDetectedAt: new Date(Date.now() - 2 * 86_400_000),
      lastSeenAt: new Date(Date.now() - 30 * 60_000),
    });

    // --- demo photos (#46) ---
    // Seminyak and Ubud get a gallery; CANGGU DELIBERATELY DOES NOT. The seed
    // already withholds licenseNo from Canggu to demo the conditional Verified
    // badge - same instinct here: one bare property means the demo shows the
    // publishable checklist doing its job, and proves the public page renders
    // without a gallery rather than breaking (ADR-0004).
    //
    // Inside the transaction so a storage failure mid-way cannot leave rows
    // pointing at objects that were never uploaded.
    const photos = await uploadSeedPhotos([
      { tenantId: T1, propertyId: P_SEMINYAK, palette: "seminyak", count: 3 },
      { tenantId: T2, propertyId: P_UBUD, palette: "ubud", count: 3 },
    ]);
    for (const [propertyId, keys] of photos) {
      await tx
        .update(property)
        .set({ photos: keys })
        .where(eq(property.id, propertyId));
    }
  });

  // Report final counts.
  const n = async (table: PgTable) => {
    const [row] = await db.select({ n: count() }).from(table);
    return row.n;
  };
  console.log(
    `Seeded: ${await n(tenant)} tenants, ${await n(property)} properties, ${await n(unit)} units, ${await n(booking)} bookings, ${await n(payment)} payments, ${await n(syncConflict)} sync conflict.`,
  );
  console.log(
    `Demo logins: owner@balibreeze.test / owner@ubudretreats.test - password "${DEMO_PASSWORD}"`,
  );
  // The demo script (docs/demo.md) names these by role, never by absolute date -
  // they move with the calendar. Print them so a presenter can check the state
  // they are about to talk over, and so "all in the future" is visible, not
  // claimed.
  const freeUntil = new Date(
    Date.parse(`${D.firstFreeNight}T00:00:00Z`) + DEMO_FREE_NIGHTS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  console.log(
    [
      "Demo window (all future, half-open, all within a week):",
      `  Wayan D., paid direct  ${D.villaDirect.checkIn} -> ${D.villaDirect.checkOut}  (Whole Villa)`,
      `  refused Airbnb import  ${D.refusedImport.checkIn} -> ${D.refusedImport.checkOut}  (the inbox conflict)`,
      `  Komang S., live hold   ${D.gardenHold.checkIn} -> ${D.gardenHold.checkOut}  (Garden Room, 15 min)`,
      `  maintenance block      ${D.surfBlock.checkIn} -> ${D.surfBlock.checkOut}  (Surf Loft)`,
      `  imported from Airbnb   ${D.villaImported.checkIn} -> ${D.villaImported.checkOut}  (Whole Villa)`,
      `  bookable gap           ${D.firstFreeNight} -> ${freeUntil}  (Whole Villa, ${DEMO_FREE_NIGHTS} nights = its min stay)`,
    ].join("\n"),
  );
  // The dashboard opens on the current MONTH, and nothing can put a future stay
  // into a month with no future days left. Say so when it applies, rather than
  // letting the presenter meet an empty first screen.
  const today = new Date();
  const daysLeftInMonth =
    new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() -
    today.getDate();
  if (daysLeftInMonth < 6) {
    console.log(
      `NOTE: only ${daysLeftInMonth} day(s) left in this month, so some seeded stays fall into next month.\n      /app/calendar opens on this month - click the next-month arrow to see them all.`,
    );
  }
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
