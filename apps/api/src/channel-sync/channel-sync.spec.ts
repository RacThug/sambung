import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import {
  booking,
  bookingSource,
  channelConnection,
  syncStatus,
  tenant,
} from '@sambung/db';
import {
  channelConnectionResponseSchema,
  channelSchema,
  syncStatusSchema,
  type AuthResponse,
  type ChannelConnectionResponse,
  type DisconnectChannelResponse,
  type PropertyResponse,
  type UnitResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { FakeIcalFetcher } from './fake-ical-fetcher';
import { ICAL_FETCHER } from './ical-fetcher';

/**
 * Channel connection lifecycle + iCal export feed (api-spec §7.1/7.2/7.4/7.6, #55)
 * over real HTTP + real Postgres. The outbound iCal fetch is a fake bound over
 * ICAL_FETCHER (api-spec §8.5), so no test hits the network.
 */
describe('Channel sync (#55)', () => {
  let app: INestApplication;
  let dbs: DbService;
  const fake = new FakeIcalFetcher();
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  const daysFromToday = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  // Tenant A (the owner under test) + tenant B (the cross-tenant intruder).
  let tokenA: string;
  let tenantAId: string;
  let unitAId: string;
  let tokenB: string;
  let tenantBId: string;

  async function registerTenant(label: string): Promise<AuthResponse> {
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: `${label} ${randomUUID()}`,
        email: `${label}+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      })
      .expect(201);
    return bodyOf<AuthResponse>(res);
  }

  async function createUnit(token: string): Promise<UnitResponse> {
    const prop = bodyOf<PropertyResponse>(
      await request(server())
        .post('/api/properties')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Channel Villa' })
        .expect(201),
    );
    return bodyOf<UnitResponse>(
      await request(server())
        .post(`/api/properties/${prop.id}/units`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Room ${randomUUID()}`, basePriceIdr: 1_000_000 })
        .expect(201),
    );
  }

  const connect = (
    unitId: string,
    body: Record<string, unknown>,
    token = tokenA,
  ) =>
    request(server())
      .post(`/api/units/${unitId}/channels`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const validUrl = 'https://www.airbnb.com/calendar/ical/12345.ics';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The whole point of the port: swap the real fetcher for a fake, so connect
      // runs end-to-end with no network (api-spec §8.5).
      .overrideProvider(ICAL_FETCHER)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);

    const a = await registerTenant('chan-a');
    tokenA = a.accessToken;
    tenantAId = a.tenant.id;
    createdTenantIds.push(a.tenant.id);
    unitAId = (await createUnit(tokenA)).id;

    const b = await registerTenant('chan-b');
    tokenB = b.accessToken;
    tenantBId = b.tenant.id;
    createdTenantIds.push(b.tenant.id);
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  beforeEach(() => {
    fake.calls.length = 0;
    fake.nextResult = { ok: true, error: null };
  });

  // --- Connect (api-spec §7.1, #28) ----------------------------------------

  describe('POST /units/:id/channels', () => {
    it('connects, smoke-fetches once, and records lastStatus=ok', async () => {
      const res = await connect(unitAId, {
        channel: 'airbnb',
        importIcalUrl: validUrl,
      }).expect(201);

      const conn = channelConnectionResponseSchema.parse(bodyOf(res));
      expect(conn).toMatchObject({
        unitId: unitAId,
        channel: 'airbnb',
        importIcalUrl: validUrl,
        lastStatus: 'ok',
        lastError: null,
      });
      expect(conn.lastSyncedAt).not.toBeNull();
      // The URL was actually smoke-fetched, exactly once.
      expect(fake.calls).toEqual([validUrl]);

      // cleanup so later duplicate/isolation tests start clean on this unit
      await request(server())
        .delete(`/api/channels/${conn.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
    });

    it('still connects when the feed is unreachable, with lastStatus=error', async () => {
      fake.nextResult = { ok: false, error: 'Feed is unreachable' };
      const res = await connect(unitAId, {
        channel: 'vrbo',
        importIcalUrl: 'https://vrbo.com/ical/x.ics',
      }).expect(201);

      const conn = bodyOf<ChannelConnectionResponse>(res);
      expect(conn.lastStatus).toBe('error');
      expect(conn.lastError).toBe('Feed is unreachable');
      // A failed probe never "synced".
      expect(conn.lastSyncedAt).toBeNull();

      await request(server())
        .delete(`/api/channels/${conn.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
    });

    it('409s a duplicate (unit, channel) with code channel_already_connected', async () => {
      const first = bodyOf<ChannelConnectionResponse>(
        await connect(unitAId, {
          channel: 'booking_com',
          importIcalUrl: validUrl,
        }).expect(201),
      );
      const res = await connect(unitAId, {
        channel: 'booking_com',
        importIcalUrl: 'https://booking.com/ical/other.ics',
      }).expect(409);
      expect(bodyOf<{ code: string }>(res).code).toBe(
        'channel_already_connected',
      );

      await request(server())
        .delete(`/api/channels/${first.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
    });

    it('400s a non-https URL, naming the field', async () => {
      const res = await connect(unitAId, {
        channel: 'airbnb',
        importIcalUrl: 'http://insecure.example/x.ics',
      }).expect(400);
      expect(
        bodyOf<{ message: Array<{ path: string }> }>(res).message,
      ).toContainEqual(expect.objectContaining({ path: 'importIcalUrl' }));
      // A rejected body never reaches the smoke fetch.
      expect(fake.calls).toHaveLength(0);
    });

    it('400s an unknown channel value', async () => {
      await connect(unitAId, {
        channel: 'expedia',
        importIcalUrl: validUrl,
      }).expect(400);
    });

    it('404s an unknown unit id', async () => {
      await connect(randomUUID(), {
        channel: 'airbnb',
        importIcalUrl: validUrl,
      }).expect(404);
    });

    it('400s a malformed unit uuid before any lookup', async () => {
      await connect('not-a-uuid', {
        channel: 'airbnb',
        importIcalUrl: validUrl,
      }).expect(400);
    });
  });

  // --- List (api-spec §7.2, #29) -------------------------------------------

  describe('GET /units/:id/channels', () => {
    it('lists a unit’s connections with status', async () => {
      const created = bodyOf<ChannelConnectionResponse>(
        await connect(unitAId, {
          channel: 'airbnb',
          importIcalUrl: validUrl,
        }).expect(201),
      );
      const res = await request(server())
        .get(`/api/units/${unitAId}/channels`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      const list = bodyOf<ChannelConnectionResponse[]>(res);
      expect(list.map((c) => c.channel)).toContain('airbnb');
      expect(
        list.every((c) => syncStatusSchema.safeParse(c.lastStatus).success),
      ).toBe(true);

      await request(server())
        .delete(`/api/channels/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
    });

    it('404s an unknown unit id', async () => {
      await request(server())
        .get(`/api/units/${randomUUID()}/channels`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });
  });

  // --- Disconnect (api-spec §7.4, #30) -------------------------------------

  describe('DELETE /channels/:id', () => {
    it('keeps imported bookings and reports how many remain', async () => {
      const conn = bodyOf<ChannelConnectionResponse>(
        await connect(unitAId, {
          channel: 'airbnb',
          importIcalUrl: validUrl,
        }).expect(201),
      );
      // An imported booking through this connection (like the cron would create).
      const [imported] = await dbs.db
        .insert(booking)
        .values({
          tenantId: tenantAId,
          unitId: unitAId,
          source: 'airbnb',
          status: 'confirmed',
          checkIn: daysFromToday(50),
          checkOut: daysFromToday(53),
          guestName: 'Airbnb guest',
          channelConnectionId: conn.id,
          externalUid: `evt-${randomUUID()}`,
        })
        .returning({ id: booking.id });

      const res = await request(server())
        .delete(`/api/channels/${conn.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(bodyOf<DisconnectChannelResponse>(res)).toEqual({
        importedBookingsKept: 1,
      });

      // The booking SURVIVES (never auto-cancelled) with its channel link nulled.
      const [row] = await dbs.db
        .select()
        .from(booking)
        .where(eq(booking.id, imported.id));
      expect(row).toBeDefined();
      expect(row.status).toBe('confirmed');
      expect(row.channelConnectionId).toBeNull();
      // The connection itself is gone.
      expect(
        await dbs.db
          .select()
          .from(channelConnection)
          .where(eq(channelConnection.id, conn.id)),
      ).toHaveLength(0);
    });

    it('reports zero kept when no bookings were imported', async () => {
      const conn = bodyOf<ChannelConnectionResponse>(
        await connect(unitAId, {
          channel: 'vrbo',
          importIcalUrl: 'https://vrbo.com/ical/z.ics',
        }).expect(201),
      );
      const res = await request(server())
        .delete(`/api/channels/${conn.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(bodyOf<DisconnectChannelResponse>(res)).toEqual({
        importedBookingsKept: 0,
      });
    });

    it('404s an unknown connection id', async () => {
      await request(server())
        .delete(`/api/channels/${randomUUID()}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });
  });

  // --- Export feed (api-spec §7.6, #34) ------------------------------------

  describe('GET /public/units/:id/calendar.ics', () => {
    it('serves confirmed bookings as all-day events, DTEND exclusive, no PII', async () => {
      const unit = await createUnit(tokenA);
      // A confirmed direct booking (must appear).
      await dbs.db.insert(booking).values({
        tenantId: tenantAId,
        unitId: unit.id,
        source: 'direct',
        status: 'confirmed',
        checkIn: daysFromToday(10),
        checkOut: daysFromToday(13),
        guestName: 'Top Secret Guest',
        guestEmail: 'secret@example.com',
        guestPhone: '+62 812 9999 0000',
        totalPriceIdr: 9_990_000n,
      });
      // A live hold (must NOT appear - not confirmed).
      await dbs.db.insert(booking).values({
        tenantId: tenantAId,
        unitId: unit.id,
        source: 'direct',
        status: 'pending_payment',
        checkIn: daysFromToday(20),
        checkOut: daysFromToday(22),
        guestName: 'Hold Guest',
        holdExpiresAt: new Date(Date.now() + 15 * 60_000),
      });
      // A cancelled booking (must NOT appear - frees its nights).
      await dbs.db.insert(booking).values({
        tenantId: tenantAId,
        unitId: unit.id,
        source: 'direct',
        status: 'cancelled',
        checkIn: daysFromToday(30),
        checkOut: daysFromToday(32),
        guestName: 'Gone Guest',
      });

      const res = await request(server())
        .get(`/api/public/units/${unit.id}/calendar.ics`)
        .expect(200);
      expect(res.headers['content-type']).toContain('text/calendar');
      const ics = res.text;

      // Exactly one VEVENT (only the confirmed booking).
      expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
      // All-day, DTEND exclusive = the checkout date verbatim.
      const yyyymmdd = (iso: string) => iso.replace(/-/g, '');
      expect(ics).toContain(
        `DTSTART;VALUE=DATE:${yyyymmdd(daysFromToday(10))}`,
      );
      expect(ics).toContain(`DTEND;VALUE=DATE:${yyyymmdd(daysFromToday(13))}`);
      expect(ics).toContain('SUMMARY:Unavailable (Sambung)');

      // No guest names, emails, phones, or prices - this URL is pasted into OTAs.
      expect(ics).not.toContain('Top Secret Guest');
      expect(ics).not.toContain('secret@example.com');
      expect(ics).not.toContain('9999');
      expect(ics).not.toContain('9990000');
    });

    it('stays archive-blind: an archived unit still serves its calendar', async () => {
      const unit = await createUnit(tokenA);
      await dbs.db.insert(booking).values({
        tenantId: tenantAId,
        unitId: unit.id,
        source: 'direct',
        status: 'confirmed',
        checkIn: daysFromToday(60),
        checkOut: daysFromToday(62),
        guestName: 'Archived-unit guest',
      });
      // Retire the unit - guests can't book it, but the OTA that subscribed must
      // still be told these nights are busy, or it double-books (ADR-0016).
      await request(server())
        .post(`/api/units/${unit.id}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      const res = await request(server())
        .get(`/api/public/units/${unit.id}/calendar.ics`)
        .expect(200);
      expect(res.text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    });

    // The no-auth cross-tenant guard, made EXPLICIT (not proof-by-construction):
    // the feed is scoped to the unit's own tenant under RLS, so another tenant's
    // bookings - even on a unit with the same shape - must never appear in it.
    it('never leaks another tenant’s bookings into a unit’s feed', async () => {
      // Tenant A's export unit, with its own confirmed booking.
      const aUnit = await createUnit(tokenA);
      await dbs.db.insert(booking).values({
        tenantId: tenantAId,
        unitId: aUnit.id,
        source: 'direct',
        status: 'confirmed',
        checkIn: daysFromToday(5),
        checkOut: daysFromToday(7),
        guestName: 'Tenant A guest',
      });
      // Tenant B's unit, with a confirmed booking on DISTINCTIVE dates.
      const bUnit = await createUnit(tokenB);
      const [bBooking] = await dbs.db
        .insert(booking)
        .values({
          tenantId: tenantBId,
          unitId: bUnit.id,
          source: 'direct',
          status: 'confirmed',
          checkIn: daysFromToday(200),
          checkOut: daysFromToday(203),
          guestName: 'Tenant B guest',
        })
        .returning({ id: booking.id });

      const res = await request(server())
        .get(`/api/public/units/${aUnit.id}/calendar.ics`)
        .expect(200);
      const ics = res.text;
      const yyyymmdd = (iso: string) => iso.replace(/-/g, '');

      // A's booking is present; exactly one event - nothing of B's crossed over.
      expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
      expect(ics).toContain(`DTSTART;VALUE=DATE:${yyyymmdd(daysFromToday(5))}`);
      // None of B's identity or dates leaked.
      expect(ics).not.toContain(bBooking.id);
      expect(ics).not.toContain(yyyymmdd(daysFromToday(200)));
      expect(ics).not.toContain(yyyymmdd(daysFromToday(203)));
    });

    // The `check_out >= current_date` floor: a stay that fully ended before today
    // is dropped, so the feed stays bounded. A current/future stay still appears.
    it('excludes bookings that fully ended before today', async () => {
      const unit = await createUnit(tokenA);
      await dbs.db.insert(booking).values([
        {
          tenantId: tenantAId,
          unitId: unit.id,
          source: 'direct',
          status: 'confirmed',
          checkIn: daysFromToday(-40),
          checkOut: daysFromToday(-38), // ended weeks ago
          guestName: 'Past guest',
        },
        {
          tenantId: tenantAId,
          unitId: unit.id,
          source: 'direct',
          status: 'confirmed',
          checkIn: daysFromToday(8),
          checkOut: daysFromToday(11), // future
          guestName: 'Future guest',
        },
      ]);

      const res = await request(server())
        .get(`/api/public/units/${unit.id}/calendar.ics`)
        .expect(200);
      const ics = res.text;
      const yyyymmdd = (iso: string) => iso.replace(/-/g, '');
      expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
      expect(ics).toContain(`DTSTART;VALUE=DATE:${yyyymmdd(daysFromToday(8))}`);
      expect(ics).not.toContain(yyyymmdd(daysFromToday(-40)));
    });

    it('404s a unit that does not exist', async () => {
      await request(server())
        .get(`/api/public/units/${randomUUID()}/calendar.ics`)
        .expect(404);
    });
  });

  // --- Tenant isolation (api-spec §1, invariant #2) ------------------------

  describe('tenant isolation', () => {
    it('404s tenant B connecting/listing on tenant A’s unit', async () => {
      await connect(
        unitAId,
        { channel: 'airbnb', importIcalUrl: validUrl },
        tokenB,
      ).expect(404);
      await request(server())
        .get(`/api/units/${unitAId}/channels`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
    });

    it('404s tenant B disconnecting tenant A’s connection', async () => {
      const conn = bodyOf<ChannelConnectionResponse>(
        await connect(unitAId, {
          channel: 'airbnb',
          importIcalUrl: validUrl,
        }).expect(201),
      );
      await request(server())
        .delete(`/api/channels/${conn.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
      // A's connection is untouched.
      await request(server())
        .delete(`/api/channels/${conn.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
    });
  });

  // --- Contract: shared enum pinned to the pgEnum (api-spec §8.6) -----------

  it('pins syncStatusSchema to the sync_status pgEnum', () => {
    expect([...syncStatusSchema.options].sort()).toEqual(
      [...syncStatus.enumValues].sort(),
    );
  });

  // The import writes a booking with `source = connection.channel` (#56,
  // ical-import.service). That cast is only sound while every Channel is also a
  // valid booking_source. This pins the subset so adding a channel WITHOUT the
  // matching pgEnum value fails here, not at a runtime insert on the cron.
  it('pins channelSchema as a subset of the booking_source pgEnum', () => {
    const sources = new Set<string>(bookingSource.enumValues);
    for (const channel of channelSchema.options) {
      expect(sources.has(channel)).toBe(true);
    }
  });
});
