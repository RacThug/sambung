/**
 * Seed: 2 tenants, 3 properties, units, and sample bookings — instant demo state.
 *
 * Idempotent: wipes all rows then re-inserts, inside one transaction, with fixed
 * UUIDs so demo links stay stable across runs. Dev/demo only.
 *
 * Run: pnpm --filter @sambung/db db:seed
 */
import { prisma } from "../src/index";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

// Fixed IDs so re-seeding is stable and demo URLs don't change.
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

// NOTE: placeholder, NOT a real hash. Real password hashing arrives with auth (#5).
const FAKE_HASH = "seed:not-a-real-hash";

async function main() {
  await prisma.$transaction(async (tx) => {
    // --- wipe (FK-safe order) so the seed is idempotent ---
    await tx.paymentEvent.deleteMany();
    await tx.payment.deleteMany();
    await tx.booking.deleteMany();
    await tx.channelConnection.deleteMany();
    await tx.userProperty.deleteMany();
    await tx.unit.deleteMany();
    await tx.property.deleteMany();
    await tx.appUser.deleteMany();
    await tx.tenant.deleteMany();

    // --- tenants + owners ---
    await tx.tenant.create({ data: { id: T1, name: "Bali Breeze Villas" } });
    await tx.tenant.create({ data: { id: T2, name: "Ubud Retreats" } });

    await tx.appUser.create({
      data: {
        tenantId: T1,
        email: "owner@balibreeze.test",
        passwordHash: FAKE_HASH,
        role: "owner",
      },
    });
    await tx.appUser.create({
      data: {
        tenantId: T2,
        email: "owner@ubudretreats.test",
        passwordHash: FAKE_HASH,
        role: "owner",
      },
    });

    // --- properties (3) ---
    await tx.property.create({
      data: {
        id: P_SEMINYAK,
        tenantId: T1,
        name: "Seminyak Beach Villa",
        address: "Jl. Kayu Aya, Seminyak, Bali",
        latitude: -8.6905,
        longitude: 115.1656,
        description: "Two-bedroom villa steps from Seminyak beach.",
        licenseNo: "NIB-1234567890", // → "Verified" badge
      },
    });
    await tx.property.create({
      data: {
        id: P_CANGGU,
        tenantId: T1,
        name: "Canggu Surf House",
        address: "Jl. Pantai Batu Bolong, Canggu, Bali",
        latitude: -8.6478,
        longitude: 115.1385,
        description: "Surf-style loft a short walk from Batu Bolong.",
        // no licenseNo → no Verified badge (demonstrates the conditional badge)
      },
    });
    await tx.property.create({
      data: {
        id: P_UBUD,
        tenantId: T2,
        name: "Ubud Jungle Villa",
        address: "Jl. Raya Tegallalang, Ubud, Bali",
        latitude: -8.4312,
        longitude: 115.2769,
        description: "Riverside suite overlooking the jungle.",
        licenseNo: "NIB-0987654321",
      },
    });

    // --- units (4) ---
    await tx.unit.createMany({
      data: [
        { id: U_VILLA, propertyId: P_SEMINYAK, tenantId: T1, name: "Whole Villa", basePriceIdr: 3_500_000n, maxGuests: 4, minStay: 2 },
        { id: U_GARDEN, propertyId: P_SEMINYAK, tenantId: T1, name: "Garden Room", basePriceIdr: 1_200_000n, maxGuests: 2, minStay: 1 },
        { id: U_SURF, propertyId: P_CANGGU, tenantId: T1, name: "Surf Loft", basePriceIdr: 950_000n, maxGuests: 2, minStay: 1 },
        { id: U_RIVER, propertyId: P_UBUD, tenantId: T2, name: "Riverside Suite", basePriceIdr: 2_100_000n, maxGuests: 2, minStay: 2 },
      ],
    });

    // --- a channel connection (Airbnb) on the Whole Villa ---
    await tx.channelConnection.create({
      data: {
        id: CC_AIRBNB,
        unitId: U_VILLA,
        tenantId: T1,
        channel: "airbnb",
        importIcalUrl: "https://www.airbnb.com/calendar/ical/EXAMPLE.ics",
        lastStatus: "ok",
        lastSyncedAt: d("2026-07-20"),
      },
    });

    // --- sample bookings (non-overlapping per unit; respects no_overlap) ---
    // Whole Villa: a direct booking + an OTA-imported one on different dates.
    const directVilla = await tx.booking.create({
      data: {
        tenantId: T1,
        unitId: U_VILLA,
        source: "direct",
        status: "confirmed",
        checkIn: d("2026-08-01"),
        checkOut: d("2026-08-05"),
        guestName: "Wayan D.",
        guestContact: "+62 812-0000-0001",
        totalPriceIdr: 14_000_000n,
      },
    });
    await tx.booking.create({
      data: {
        tenantId: T1,
        unitId: U_VILLA,
        source: "airbnb",
        status: "confirmed",
        checkIn: d("2026-08-10"),
        checkOut: d("2026-08-14"),
        guestName: "Airbnb guest",
        channelConnectionId: CC_AIRBNB,
        externalUid: "airbnb-evt-0001@airbnb.com", // idempotent re-sync key
      },
    });

    // Garden Room: a live hold (pending_payment) that would block those dates.
    await tx.booking.create({
      data: {
        tenantId: T1,
        unitId: U_GARDEN,
        source: "direct",
        status: "pending_payment",
        checkIn: d("2026-08-03"),
        checkOut: d("2026-08-06"),
        guestName: "Komang S.",
        guestContact: "+62 812-0000-0002",
        totalPriceIdr: 3_600_000n,
        holdExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // Surf Loft: a manual maintenance block.
    await tx.booking.create({
      data: {
        tenantId: T1,
        unitId: U_SURF,
        source: "manual_block",
        status: "confirmed",
        checkIn: d("2026-08-15"),
        checkOut: d("2026-08-18"),
        guestName: null,
      },
    });

    // Riverside Suite (tenant 2): a direct confirmed booking.
    await tx.booking.create({
      data: {
        tenantId: T2,
        unitId: U_RIVER,
        source: "direct",
        status: "confirmed",
        checkIn: d("2026-09-01"),
        checkOut: d("2026-09-04"),
        guestName: "Asian traveler",
        guestContact: "+86 138-0000-0003",
        totalPriceIdr: 6_300_000n,
      },
    });

    // A paid payment for the Whole Villa direct booking.
    await tx.payment.create({
      data: {
        bookingId: directVilla.id,
        provider: "midtrans",
        providerRef: "SEED-ORDER-0001",
        amountIdr: 14_000_000n,
        status: "paid",
      },
    });
  });

  // Report final counts.
  const [tenants, properties, units, bookings, payments] = await Promise.all([
    prisma.tenant.count(),
    prisma.property.count(),
    prisma.unit.count(),
    prisma.booking.count(),
    prisma.payment.count(),
  ]);
  console.log(
    `Seeded: ${tenants} tenants, ${properties} properties, ${units} units, ${bookings} bookings, ${payments} payments.`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
