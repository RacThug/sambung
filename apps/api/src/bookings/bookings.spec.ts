import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import {
  booking,
  bookingSource,
  bookingStatus,
  property,
  tenant,
  unit,
} from '@sambung/db';
import {
  bookingSourceSchema,
  bookingStatusSchema,
  type AuthResponse,
  type CreateBookingResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { testSlug } from '../test-helpers';
import { HoldSweeperService } from './hold-sweeper.service';

/**
 * Boss fight #1 - the guest booking write + hold-expiry sweeper (api-spec §5.3,
 * #48). The point of the whole design is that no single layer is correct alone,
 * so the tests exercise each seam: the transaction re-check (min_stay/max_guests/
 * archived), the exclusion-constraint race (two identical bookings, one wins),
 * the pessimistic hold, and both sweeps (opportunistic in-transaction + cron).
 *
 * Real concurrency, real Postgres: the race test fires two POSTs at once and the
 * constraint arbitrates - a mock could never prove one 201 / one 409.
 */
describe('Guest booking + hold sweeper', () => {
  let app: INestApplication;
  let dbs: DbService;
  let sweeper: HoldSweeperService;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  // unitStd: price 1,000,000/night, minStay 2, maxGuests 2 - the main subject.
  let unitStdId: string;
  let unitArchivedId: string; // archived on its own account
  let tenantAId: string;

  const book = (overrides: Record<string, unknown> = {}) =>
    request(server())
      .post('/api/public/bookings')
      .send({
        unitId: unitStdId,
        checkIn: '2027-01-10',
        checkOut: '2027-01-14',
        guestName: 'Made A.',
        guestPhone: '+62 812 3456 7890',
        guestCount: 2,
        ...overrides,
      });

  /** Seed an occupying/lapsed booking directly (owner connection, bypasses RLS). */
  const seedBooking = (values: {
    unitId: string;
    checkIn: string;
    checkOut: string;
    status: 'pending_payment' | 'confirmed';
    source?: 'direct' | 'manual_block';
    holdExpiresAt?: Date;
  }) =>
    dbs.db
      .insert(booking)
      .values({
        tenantId: tenantAId,
        unitId: values.unitId,
        source: values.source ?? 'manual_block',
        status: values.status,
        checkIn: values.checkIn,
        checkOut: values.checkOut,
        holdExpiresAt: values.holdExpiresAt,
      })
      .returning({ id: booking.id })
      .then((rows) => rows[0].id);

  const statusOf = async (id: string): Promise<string> => {
    const [row] = await dbs.db
      .select({ status: booking.status })
      .from(booking)
      .where(eq(booking.id, id));
    return row.status;
  };

  const occupyingCount = async (unitId: string, checkIn: string) => {
    const rows = await dbs.db
      .select({ id: booking.id })
      .from(booking)
      .where(and(eq(booking.unitId, unitId), eq(booking.checkIn, checkIn)));
    return rows.length;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);
    sweeper = app.get(HoldSweeperService);

    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: 'Booking Tenant A',
        email: `book+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      });
    const auth = bodyOf<AuthResponse>(res);
    tenantAId = auth.tenant.id;
    createdTenantIds.push(tenantAId);

    const [prop] = await dbs.db
      .insert(property)
      .values({ tenantId: tenantAId, name: 'Booking Villa', slug: testSlug() })
      .returning({ id: property.id });

    const [std, archived] = await dbs.db
      .insert(unit)
      .values([
        {
          propertyId: prop.id,
          tenantId: tenantAId,
          name: 'Standard Room',
          basePriceIdr: 1_000_000n,
          minStay: 2,
          maxGuests: 2,
        },
        {
          propertyId: prop.id,
          tenantId: tenantAId,
          name: 'Retired Room',
          basePriceIdr: 1_000_000n,
          archivedAt: new Date('2026-07-01T00:00:00Z'),
        },
      ])
      .returning({ id: unit.id });
    unitStdId = std.id;
    unitArchivedId = archived.id;
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  // --- Happy path -----------------------------------------------------------

  it('creates a pending_payment hold with a server-computed price', async () => {
    const res = await book({ checkIn: '2027-01-10', checkOut: '2027-01-14' });
    expect(res.status).toBe(201);

    const b = bodyOf<CreateBookingResponse>(res);
    expect(b.status).toBe('pending_payment');
    expect(b.nights).toBe(4);
    expect(b.totalPriceIdr).toBe(4_000_000); // 1,000,000 x 4 nights, server-side
    expect(b.bookingId).toMatch(/^[0-9a-f-]{36}$/);

    // hold_expires_at is now() + 15 min on the DB clock (a couple minutes of slack).
    const msAway = new Date(b.holdExpiresAt).getTime() - Date.now();
    expect(msAway).toBeGreaterThan(13 * 60_000);
    expect(msAway).toBeLessThan(17 * 60_000);
  });

  it("stamps the created row's tenant_id to the unit's tenant", async () => {
    const res = await book({ checkIn: '2027-01-20', checkOut: '2027-01-23' });
    const { bookingId } = bodyOf<CreateBookingResponse>(res);
    const [row] = await dbs.db
      .select({ tenantId: booking.tenantId, source: booking.source })
      .from(booking)
      .where(eq(booking.id, bookingId));
    expect(row.tenantId).toBe(tenantAId);
    expect(row.source).toBe('direct');
  });

  // --- AC #1: the double-booking race --------------------------------------

  it('resolves two parallel identical bookings as exactly one 201 / one 409', async () => {
    const dates = { checkIn: '2027-02-10', checkOut: '2027-02-14' };
    const [r1, r2] = await Promise.all([book(dates), book(dates)]);

    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([201, 409]);
    // The loser blamed the overlap - the same reason the pre-check would give.
    const loser = r1.status === 409 ? r1 : r2;
    expect(bodyOf<{ reasons: string[] }>(loser).reasons).toEqual(['overlap']);
    // And the DB holds exactly one occupying booking for those nights.
    expect(await occupyingCount(unitStdId, '2027-02-10')).toBe(1);
  });

  it('maps the exclusion-constraint violation to a 409 (deterministic, not raced)', async () => {
    // Pre-seed a confirmed booking, then book overlapping dates: the re-check
    // catches it, but this proves the constraint->409 mapping regardless of timing.
    await seedBooking({
      unitId: unitStdId,
      checkIn: '2027-03-10',
      checkOut: '2027-03-14',
      status: 'confirmed',
    });
    const res = await book({ checkIn: '2027-03-12', checkOut: '2027-03-16' });
    expect(res.status).toBe(409);
    expect(bodyOf<{ reasons: string[] }>(res).reasons).toEqual(['overlap']);
  });

  // --- AC #4: the refusal vocabulary ---------------------------------------

  it('refuses a stay shorter than min_stay with a 409', async () => {
    const res = await book({ checkIn: '2027-04-10', checkOut: '2027-04-11' }); // 1 < 2
    expect(res.status).toBe(409);
    expect(bodyOf<{ reasons: string[] }>(res).reasons).toEqual(['min_stay']);
  });

  it('refuses a party over the unit capacity with a 409', async () => {
    const res = await book({
      checkIn: '2027-05-10',
      checkOut: '2027-05-14',
      guestCount: 3, // maxGuests is 2
    });
    expect(res.status).toBe(409);
    expect(bodyOf<{ reasons: string[] }>(res).reasons).toEqual(['max_guests']);
  });

  it('reports every reason at once when a booking fails several ways', async () => {
    await seedBooking({
      unitId: unitStdId,
      checkIn: '2027-06-01',
      checkOut: '2027-06-15',
      status: 'confirmed',
    });
    const res = await book({
      checkIn: '2027-06-10',
      checkOut: '2027-06-11', // 1 night: overlaps AND under min_stay
      guestCount: 5, // AND over capacity
    });
    expect(res.status).toBe(409);
    expect([...bodyOf<{ reasons: string[] }>(res).reasons].sort()).toEqual([
      'max_guests',
      'min_stay',
      'overlap',
    ]);
  });

  it('refuses a booking on an archived unit as `unavailable` (never "archived")', async () => {
    const res = await book({
      unitId: unitArchivedId,
      checkIn: '2027-01-10',
      checkOut: '2027-01-14',
    });
    expect(res.status).toBe(409);
    const b = bodyOf<{ reasons: string[]; message: string }>(res);
    expect(b.reasons).toEqual(['unavailable']);
    expect(JSON.stringify(b)).not.toContain('archived');
  });

  it("404s an unknown unit id (indistinguishable from another tenant's)", async () => {
    const res = await book({ unitId: randomUUID() });
    expect(res.status).toBe(404);
  });

  // --- AC #3: the sweeps ----------------------------------------------------

  it('opportunistically frees a lapsed hold in-transaction, so the same dates book', async () => {
    const lapsedId = await seedBooking({
      unitId: unitStdId,
      checkIn: '2027-07-10',
      checkOut: '2027-07-14',
      status: 'pending_payment',
      source: 'direct',
      holdExpiresAt: new Date(Date.now() - 60_000), // lapsed a minute ago
    });

    // Same dates: without the opportunistic sweep this would 409 at the
    // constraint. With it, the dead hold is expired first and the booking wins.
    const res = await book({ checkIn: '2027-07-10', checkOut: '2027-07-14' });
    expect(res.status).toBe(201);
    expect(await statusOf(lapsedId)).toBe('expired');
  });

  it('sweeps expired holds via the cron method, frees the dates, and is idempotent', async () => {
    const lapsedId = await seedBooking({
      unitId: unitStdId,
      checkIn: '2027-08-10',
      checkOut: '2027-08-14',
      status: 'pending_payment',
      source: 'direct',
      holdExpiresAt: new Date(Date.now() - 60_000),
    });

    const swept = await sweeper.sweepExpiredHolds();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await statusOf(lapsedId)).toBe('expired');

    // Freed dates are immediately bookable.
    const res = await book({ checkIn: '2027-08-10', checkOut: '2027-08-14' });
    expect(res.status).toBe(201);

    // Idempotent: the new hold has a future TTL, nothing lapsed remains.
    expect(await sweeper.sweepExpiredHolds()).toBe(0);
    expect(await statusOf(lapsedId)).toBe('expired');
  });

  it('lets the changeover day rebook: a checkout is the next check-in', async () => {
    // [09-10,09-13) then [09-13,09-16) - half-open, so they do NOT overlap.
    const first = await book({ checkIn: '2027-09-10', checkOut: '2027-09-13' });
    expect(first.status).toBe(201);
    const next = await book({ checkIn: '2027-09-13', checkOut: '2027-09-16' });
    expect(next.status).toBe(201);
  });

  // --- Boundary validation (400 at the boundary, before any DB work) --------

  it('400s a non-phone contact, a bad window, and an out-of-range party', async () => {
    const badPhone = await book({ guestPhone: 'call-me-maybe' });
    expect(badPhone.status).toBe(400);

    const badWindow = await book({
      checkIn: '2027-10-14',
      checkOut: '2027-10-10',
    });
    expect(badWindow.status).toBe(400);

    const badCount = await book({ guestCount: 0 });
    expect(badCount.status).toBe(400);

    const badDate = await book({
      checkIn: '2027-02-30',
      checkOut: '2027-03-05',
    });
    expect(badDate.status).toBe(400);
  });

  // --- Contract: shared enums pinned to the pgEnum (api-spec §8.6) ----------

  it('pins bookingStatusSchema and bookingSourceSchema to their pgEnums', () => {
    expect([...bookingStatusSchema.options].sort()).toEqual(
      [...bookingStatus.enumValues].sort(),
    );
    expect([...bookingSourceSchema.options].sort()).toEqual(
      [...bookingSource.enumValues].sort(),
    );
  });
});
