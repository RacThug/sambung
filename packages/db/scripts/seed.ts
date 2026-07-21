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

// Sample bookings are anchored to the CURRENT month, not fixed calendar dates,
// so the unified calendar's default view (this month) is populated the moment
// you seed - a fixed August date silently falls outside the view once the month
// passes. Only the DATES move with time; the stable demo surface (ids, slugs,
// logins) stays fixed. `day(n)` = the nth day of the current month, half-open.
const monthAnchor = new Date();
const monthStart = `${monthAnchor.getFullYear()}-${String(monthAnchor.getMonth() + 1).padStart(2, "0")}-01`;
const day = (offset: number): string =>
  new Date(Date.parse(`${monthStart}T00:00:00Z`) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

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
    await tx.insert(unit).values([
      {
        id: U_VILLA,
        propertyId: P_SEMINYAK,
        tenantId: T1,
        name: "Whole Villa",
        basePriceIdr: 3_500_000n,
        maxGuests: 4,
        minStay: 2,
      },
      {
        id: U_GARDEN,
        propertyId: P_SEMINYAK,
        tenantId: T1,
        name: "Garden Room",
        basePriceIdr: 1_200_000n,
        maxGuests: 2,
        minStay: 1,
      },
      {
        id: U_SURF,
        propertyId: P_CANGGU,
        tenantId: T1,
        name: "Surf Loft",
        basePriceIdr: 950_000n,
        maxGuests: 2,
        minStay: 1,
      },
      {
        id: U_RIVER,
        propertyId: P_UBUD,
        tenantId: T2,
        name: "Riverside Suite",
        basePriceIdr: 2_100_000n,
        maxGuests: 2,
        minStay: 2,
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
      lastSyncedAt: new Date("2026-07-20T00:00:00.000Z"),
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
        checkIn: day(4),
        checkOut: day(8),
        guestName: "Wayan D.",
        guestPhone: "+62 812-0000-0001",
        guestEmail: "wayan@example.com",
        guestCount: 3,
        totalPriceIdr: 14_000_000n,
      })
      .returning({ id: booking.id });

    await tx.insert(booking).values([
      {
        tenantId: T1,
        unitId: U_VILLA,
        source: "airbnb",
        status: "confirmed",
        checkIn: day(13),
        checkOut: day(17),
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
        checkIn: day(6),
        checkOut: day(9),
        guestName: "Komang S.",
        guestPhone: "+62 812-0000-0002",
        guestCount: 2,
        totalPriceIdr: 3_600_000n,
        holdExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
      // Surf Loft: a manual maintenance block.
      {
        tenantId: T1,
        unitId: U_SURF,
        source: "manual_block",
        status: "confirmed",
        checkIn: day(17),
        checkOut: day(20),
        guestName: null,
      },
      // Riverside Suite (tenant 2): a direct confirmed booking.
      {
        tenantId: T2,
        unitId: U_RIVER,
        source: "direct",
        status: "confirmed",
        checkIn: day(8),
        checkOut: day(11),
        guestName: "Asian traveler",
        guestPhone: "+86 138-0000-0003",
        guestCount: 2,
        totalPriceIdr: 6_300_000n,
      },
    ]);

    // A paid payment for the Whole Villa direct booking.
    await tx.insert(payment).values({
      bookingId: directVilla.id,
      provider: "midtrans",
      providerRef: "SEED-ORDER-0001",
      amountIdr: 14_000_000n,
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
    // Dates: day(5)-day(9) against Wayan's day(4)-day(8) - a PARTIAL overlap on
    // purpose. Identical dates would hide the bug where the two ranges get
    // conflated; a partial one makes the inbox prove it shows both.
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
      checkIn: day(5),
      checkOut: day(9),
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
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
