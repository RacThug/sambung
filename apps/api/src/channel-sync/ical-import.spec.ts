import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { booking, tenant, type Booking } from '@sambung/db';
import type {
  AuthResponse,
  AvailabilityResponse,
  ChannelConnectionResponse,
  PropertyResponse,
  SyncAllResponse,
  SyncConnectionResponse,
  UnitResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { FakeIcalFetcher } from './fake-ical-fetcher';
import { ICAL_FETCHER } from './ical-fetcher';
import { IcalImportService } from './ical-import.service';
import { buildCalendar } from './ical';

/**
 * iCal IMPORT pipeline (#56, boss fight #3) over real HTTP + real Postgres. The
 * outbound feed is a FakeIcalFetcher bound over ICAL_FETCHER (api-spec §8.5), so a
 * test stages a feed body with `fake.setFeed(url, body)` and no suite hits the
 * network. "Sync now" (the HTTP endpoint) and the cron entry (syncAllConnections,
 * driven directly - ScheduleModule is off under test) share one reconcile core.
 *
 * One `it` per acceptance criterion, plus the savepoint seam (an overlapping
 * VEVENT is skipped, the cycle survives) that the #38 conflict inbox will build on.
 */
describe('iCal import (#56)', () => {
  let app: INestApplication;
  let dbs: DbService;
  let importer: IcalImportService;
  const fake = new FakeIcalFetcher();
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  const daysFromToday = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  let tokenA: string;
  let tenantAId: string;
  let tokenB: string;

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
        .send({ name: 'Import Villa' })
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

  /** Create a fresh unit + a connection with a UNIQUE feed URL, so each test's
   * import is isolated (its own unit's bookings, its own stageable feed). */
  async function connectUnit(
    token = tokenA,
    channel = 'airbnb',
  ): Promise<{
    unitId: string;
    propertyId: string;
    connId: string;
    feedUrl: string;
  }> {
    const unit = await createUnit(token);
    const feedUrl = `https://airbnb.com/ical/${randomUUID()}.ics`;
    const conn = bodyOf<ChannelConnectionResponse>(
      await request(server())
        .post(`/api/units/${unit.id}/channels`)
        .set('Authorization', `Bearer ${token}`)
        .send({ channel, importIcalUrl: feedUrl })
        .expect(201),
    );
    return {
      unitId: unit.id,
      propertyId: unit.propertyId,
      connId: conn.id,
      feedUrl,
    };
  }

  /** A valid iCalendar body with the given busy spans, built by the export
   * serializer (so it's real, well-formed ICS). */
  const feedWith = (events: { uid: string; start: string; end: string }[]) =>
    buildCalendar({ prodId: '-//Test OTA//EN', events });

  const syncNow = (connId: string, token = tokenA) =>
    request(server())
      .post(`/api/channels/${connId}/sync`)
      .set('Authorization', `Bearer ${token}`);

  const importedBookings = (connId: string): Promise<Booking[]> =>
    dbs.db
      .select()
      .from(booking)
      .where(eq(booking.channelConnectionId, connId));

  const availability = (unitId: string, from: string, to: string) =>
    request(server())
      .get(`/api/public/units/${unitId}/availability`)
      .query({ from, to });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ICAL_FETCHER)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);
    importer = app.get(IcalImportService);

    const a = await registerTenant('imp-a');
    tokenA = a.accessToken;
    tenantAId = a.tenant.id;
    createdTenantIds.push(a.tenant.id);

    const b = await registerTenant('imp-b');
    tokenB = b.accessToken;
    createdTenantIds.push(b.tenant.id);
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  beforeEach(() => fake.reset());

  // --- AC1: a busy range blocks the direct calendar; Sync now forces it --------

  it('imports a busy range that blocks the direct calendar, forced immediately', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(10);
    const end = daysFromToday(13);
    fake.setFeed(feedUrl, feedWith([{ uid: 'ota-1', start, end }]));

    const res = await syncNow(connId).expect(200);
    const summary = bodyOf<SyncConnectionResponse>(res);
    expect(summary).toMatchObject({
      lastStatus: 'ok',
      imported: 1,
      cancelled: 0,
    });
    expect(summary.lastSyncedAt).not.toBeNull();

    // The imported booking exists: confirmed, source=channel, no guest PII, right dates.
    const rows = await importedBookings(connId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'confirmed',
      source: 'airbnb',
      checkIn: start,
      checkOut: end,
      externalUid: 'ota-1',
      guestName: null,
      guestEmail: null,
      totalPriceIdr: null,
    });

    // ...and it blocks the DIRECT availability calendar (the whole point).
    const avail = bodyOf<AvailabilityResponse>(
      await availability(unitId, start, end).expect(200),
    );
    expect(avail.available).toBe(false);
    expect(avail.reasons).toContain('overlap');
    expect(avail.blockedRanges).toContainEqual({ from: start, to: end });
  });

  // --- AC2: idempotent by UID; a changed VEVENT updates in place ---------------

  it('is idempotent on re-pull (same feed changes nothing)', async () => {
    const { connId, feedUrl } = await connectUnit();
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'dup', start: daysFromToday(20), end: daysFromToday(22) },
      ]),
    );

    await syncNow(connId).expect(200);
    const afterFirst = await importedBookings(connId);
    expect(afterFirst).toHaveLength(1);

    // Second identical pull: still exactly one row, same id (no duplicate insert).
    const res = await syncNow(connId).expect(200);
    expect(bodyOf<SyncConnectionResponse>(res)).toMatchObject({
      lastStatus: 'ok',
    });
    const afterSecond = await importedBookings(connId);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(afterFirst[0].id);
  });

  it('updates a changed VEVENT in place (same row, new dates)', async () => {
    const { connId, feedUrl } = await connectUnit();
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'move', start: daysFromToday(30), end: daysFromToday(32) },
      ]),
    );
    await syncNow(connId).expect(200);
    const before = (await importedBookings(connId))[0];

    // The guest extended their stay: same UID, later checkout.
    const newEnd = daysFromToday(35);
    fake.setFeed(
      feedUrl,
      feedWith([{ uid: 'move', start: daysFromToday(30), end: newEnd }]),
    );
    await syncNow(connId).expect(200);

    const after = await importedBookings(connId);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id); // same row, updated in place
    expect(after[0].checkOut).toBe(newEnd);
  });

  // --- AC3: absent UID (healthy) → cancelled; empty/malformed → error, none ----

  it('cancels a booking whose UID vanished from a healthy feed', async () => {
    const { connId, feedUrl } = await connectUnit();
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'keep', start: daysFromToday(40), end: daysFromToday(42) },
        { uid: 'drop', start: daysFromToday(50), end: daysFromToday(52) },
      ]),
    );
    await syncNow(connId).expect(200);
    expect(await importedBookings(connId)).toHaveLength(2);

    // Next pull, still healthy, 'drop' is gone (an OTA-side cancellation).
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'keep', start: daysFromToday(40), end: daysFromToday(42) },
      ]),
    );
    const res = await syncNow(connId).expect(200);
    expect(bodyOf<SyncConnectionResponse>(res)).toMatchObject({
      lastStatus: 'ok',
      cancelled: 1,
    });

    const rows = await importedBookings(connId);
    const byUid = new Map(rows.map((r) => [r.externalUid, r.status]));
    expect(byUid.get('keep')).toBe('confirmed');
    expect(byUid.get('drop')).toBe('cancelled');
  });

  it('marks error and cancels NOTHING on a malformed/truncated feed', async () => {
    const { connId, feedUrl } = await connectUnit();
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'safe', start: daysFromToday(60), end: daysFromToday(62) },
      ]),
    );
    await syncNow(connId).expect(200);

    // A truncated body (no terminating END:VCALENDAR) - the mass-cancel trap.
    fake.setFeed(feedUrl, 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x');
    const res = await syncNow(connId).expect(200);
    expect(bodyOf<SyncConnectionResponse>(res)).toMatchObject({
      lastStatus: 'error',
      imported: 0,
      cancelled: 0,
    });

    // The previously-imported booking is UNTOUCHED (never mass-cancelled).
    const rows = await importedBookings(connId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('confirmed');
  });

  it('marks error and cancels nothing when the feed is unreachable', async () => {
    const { connId, feedUrl } = await connectUnit();
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'live', start: daysFromToday(70), end: daysFromToday(72) },
      ]),
    );
    await syncNow(connId).expect(200);

    fake.setFeedError(feedUrl, 'Feed is unreachable');
    const res = await syncNow(connId).expect(200);
    expect(bodyOf<SyncConnectionResponse>(res)).toMatchObject({
      lastStatus: 'error',
      cancelled: 0,
    });
    expect((await importedBookings(connId))[0].status).toBe('confirmed');
  });

  // The never-mass-cancel bias in its subtlest form: a VALID but EMPTY calendar is
  // indistinguishable from a truncation-to-zero, so it stamps ok but cancels NONE.
  it('does not mass-cancel on a healthy but empty calendar', async () => {
    const { connId, feedUrl } = await connectUnit();
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'lonely', start: daysFromToday(80), end: daysFromToday(82) },
      ]),
    );
    await syncNow(connId).expect(200);

    fake.setFeed(feedUrl, feedWith([])); // valid VCALENDAR, zero VEVENTs
    const res = await syncNow(connId).expect(200);
    expect(bodyOf<SyncConnectionResponse>(res)).toMatchObject({
      lastStatus: 'ok',
      cancelled: 0,
    });
    expect((await importedBookings(connId))[0].status).toBe('confirmed');
  });

  // --- AC4: health surfaces per connection (FR-SYNC-3) -------------------------

  it('surfaces lastSyncedAt / lastStatus / lastError on the connection list', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'h', start: daysFromToday(90), end: daysFromToday(92) },
      ]),
    );
    await syncNow(connId).expect(200);

    const healthy = bodyOf<ChannelConnectionResponse[]>(
      await request(server())
        .get(`/api/units/${unitId}/channels`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200),
    ).find((c) => c.id === connId)!;
    expect(healthy.lastStatus).toBe('ok');
    expect(healthy.lastSyncedAt).not.toBeNull();
    expect(healthy.lastError).toBeNull();

    // Now an unreachable pull flips the health to error, with a reason.
    fake.setFeedError(feedUrl, 'Feed is unreachable');
    await syncNow(connId).expect(200);
    const errored = bodyOf<ChannelConnectionResponse[]>(
      await request(server())
        .get(`/api/units/${unitId}/channels`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200),
    ).find((c) => c.id === connId)!;
    expect(errored.lastStatus).toBe('error');
    expect(errored.lastError).toBe('Feed is unreachable');
  });

  // --- The savepoint seam: an overlap is skipped, the cycle survives (#38) ------

  it('skips a VEVENT that overlaps an existing booking, imports the rest, survives', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();

    // A direct confirmed booking already occupies these nights.
    const takenStart = daysFromToday(100);
    const takenEnd = daysFromToday(103);
    await dbs.db.insert(booking).values({
      tenantId: tenantAId,
      unitId,
      source: 'direct',
      status: 'confirmed',
      checkIn: takenStart,
      checkOut: takenEnd,
      guestName: 'Direct guest',
    });

    // The feed carries a VEVENT that OVERLAPS the direct booking (a real-world
    // double-sell) AND one on free nights.
    const freeStart = daysFromToday(110);
    const freeEnd = daysFromToday(112);
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'conflict', start: takenStart, end: takenEnd },
        { uid: 'clean', start: freeStart, end: freeEnd },
      ]),
    );

    const res = await syncNow(connId).expect(200);
    // The cycle did NOT crash: ok status, the clean event imported.
    expect(bodyOf<SyncConnectionResponse>(res)).toMatchObject({
      lastStatus: 'ok',
      imported: 1,
    });

    const imported = await importedBookings(connId);
    expect(imported).toHaveLength(1);
    expect(imported[0].externalUid).toBe('clean');

    // The pre-existing direct booking is untouched - never overwritten/cancelled.
    const direct = await dbs.db
      .select()
      .from(booking)
      .where(and(eq(booking.unitId, unitId), eq(booking.source, 'direct')));
    expect(direct).toHaveLength(1);
    expect(direct[0].status).toBe('confirmed');
  });

  // --- The cron entry reconciles every connection (owner connection) -----------

  it('syncAllConnections reconciles across connections (the cron path)', async () => {
    const one = await connectUnit();
    const two = await connectUnit(tokenA, 'vrbo');
    fake.setFeed(
      one.feedUrl,
      feedWith([
        { uid: 'c1', start: daysFromToday(120), end: daysFromToday(122) },
      ]),
    );
    fake.setFeed(
      two.feedUrl,
      feedWith([
        { uid: 'c2', start: daysFromToday(120), end: daysFromToday(122) },
      ]),
    );

    await importer.syncAllConnections();

    expect(await importedBookings(one.connId)).toHaveLength(1);
    expect(await importedBookings(two.connId)).toHaveLength(1);

    // AC1 "within one cycle": the cron path (not just Sync now) blocks the direct
    // calendar - the imported block reaches availability.
    const avail = bodyOf<AvailabilityResponse>(
      await availability(
        one.unitId,
        daysFromToday(120),
        daysFromToday(122),
      ).expect(200),
    );
    expect(avail.available).toBe(false);
    expect(avail.reasons).toContain('overlap');
  });

  // --- Sync now authz: tenant isolation + unknown id ---------------------------

  it('404s Sync now for another tenant’s connection (existence hidden)', async () => {
    const { connId, feedUrl } = await connectUnit();
    fake.setFeed(feedUrl, feedWith([]));
    await syncNow(connId, tokenB).expect(404);
  });

  it('404s Sync now for an unknown connection id', async () => {
    await syncNow(randomUUID()).expect(404);
  });

  // A cross-tenant guard on the WRITE path, made explicit: reconciling tenant A's
  // connection must never touch tenant B's bookings, even on identical dates.
  it('never reconciles across tenants', async () => {
    const a = await connectUnit(tokenA);
    // Tenant B has its own imported-looking booking on the SAME dates.
    const bUnit = await createUnit(tokenB);
    const bTenantId = createdTenantIds[1];
    const [bBooking] = await dbs.db
      .insert(booking)
      .values({
        tenantId: bTenantId,
        unitId: bUnit.id,
        source: 'airbnb',
        status: 'confirmed',
        checkIn: daysFromToday(130),
        checkOut: daysFromToday(132),
        externalUid: 'b-owned',
        guestName: 'B guest',
      })
      .returning();

    // A's feed drops all UIDs (empty-but-with-a-prior would cancel) - but here A
    // has one event, so cancellation runs; it must scope to A only.
    fake.setFeed(
      a.feedUrl,
      feedWith([
        { uid: 'a-only', start: daysFromToday(130), end: daysFromToday(132) },
      ]),
    );
    await syncNow(a.connId).expect(200);

    // B's booking is completely untouched by A's reconciliation.
    const [after] = await dbs.db
      .select()
      .from(booking)
      .where(eq(booking.id, bBooking.id));
    expect(after.status).toBe('confirmed');
    expect(after.channelConnectionId).toBeNull();
  });

  // --- Property-local dates (#145, ADR-0028) -------------------------------

  /** A raw ICS body with a UTC-stamped VEVENT. Hand-built, not via buildCalendar:
   * the serializer only ever emits all-day `VALUE=DATE`, which is precisely the
   * form that needs no zone. */
  const utcFeed = (uid: string, startUtc: string, endUtc: string): string =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test OTA//EN',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTART:${startUtc}`,
      `DTEND:${endUtc}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n') + '\r\n';

  const setZone = (propertyId: string, timeZone: string) =>
    request(server())
      .patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ timeZone })
      .expect(200);

  it('imports a UTC-stamped VEVENT on the night it falls in the property zone', async () => {
    const { connId, propertyId, feedUrl } = await connectUnit();

    // 16:30Z on 1 Aug is 00:30 on 2 Aug in Bali (WITA, the default) - so the
    // guest sleeps here on the 2nd. Taking the UTC date, as the parser did
    // before #145, would have blocked the 1st: one night early, both edges.
    fake.setFeed(
      feedUrl,
      utcFeed('tz-1', '20260801T163000Z', '20260804T163000Z'),
    );
    await syncNow(connId).expect(200);

    const [row] = await importedBookings(connId);
    expect(row).toMatchObject({
      checkIn: '2026-08-02',
      checkOut: '2026-08-05',
    });

    // Now say the property is actually in Java (WIB, UTC+7), where the same
    // instant is still 23:30 on the 1st, and re-pull the IDENTICAL feed. The
    // dates must move - proving the column is genuinely read, not decoration -
    // and the row must update IN PLACE (same UID, idempotent by external_uid).
    await setZone(propertyId, 'Asia/Jakarta');
    await syncNow(connId).expect(200);

    const rows = await importedBookings(connId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: row.id,
      checkIn: '2026-08-01',
      checkOut: '2026-08-04',
    });
  });

  it('leaves an all-day VEVENT on the same nights whatever the zone', async () => {
    const { connId, propertyId, feedUrl } = await connectUnit();
    const start = daysFromToday(200);
    const end = daysFromToday(203);

    fake.setFeed(feedUrl, feedWith([{ uid: 'allday-1', start, end }]));
    await syncNow(connId).expect(200);
    expect((await importedBookings(connId))[0]).toMatchObject({
      checkIn: start,
      checkOut: end,
    });

    // VALUE=DATE carries no time to convert, so a zone change must be a no-op.
    await setZone(propertyId, 'Asia/Jayapura');
    await syncNow(connId).expect(200);
    expect((await importedBookings(connId))[0]).toMatchObject({
      checkIn: start,
      checkOut: end,
    });
  });

  it('rejects an unknown time zone at the boundary, so the column stays valid', async () => {
    const { propertyId } = await connectUnit();
    await request(server())
      .patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ timeZone: 'Mars/Olympus_Mons' })
      .expect(400);
  });

  // --- Sync ALL (api-spec §7.5, #201) --------------------------------------
  // The calendar's button: one click sweeps every feed the caller can see, so an
  // owner never waits out the 30-min cron and never tours their units to say so.

  const syncAll = (token = tokenA) =>
    request(server())
      .post('/api/channels/sync')
      .set('Authorization', `Bearer ${token}`);

  describe('POST /channels/sync', () => {
    /**
     * Every case here runs as its OWN tenant. The totals are the point of this
     * endpoint, and tenant A carries a connection per test from the whole file
     * above - so a shared tenant makes an exact assertion impossible (the first
     * draft read `errored: 16`, correctly: those feeds are no longer staged).
     */
    async function freshOwner(): Promise<string> {
      const owner = await registerTenant('import-syncall');
      createdTenantIds.push(owner.tenant.id);
      return owner.accessToken;
    }

    it('pulls every connected feed and sums what happened', async () => {
      const token = await freshOwner();
      const one = await connectUnit(token);
      const two = await connectUnit(token);
      fake.setFeed(
        one.feedUrl,
        feedWith([
          { uid: 'all-1', start: daysFromToday(40), end: daysFromToday(43) },
        ]),
      );
      fake.setFeed(
        two.feedUrl,
        feedWith([
          { uid: 'all-2', start: daysFromToday(45), end: daysFromToday(47) },
        ]),
      );

      const body = bodyOf<SyncAllResponse>(await syncAll(token).expect(200));

      // Both feeds pulled in ONE request, both bookings landed. Exact totals -
      // this tenant has exactly the two connections the test made.
      expect(body).toEqual({
        feeds: 2,
        errored: 0,
        imported: 2,
        cancelled: 0,
        conflicts: 0,
      });
      expect(await importedBookings(one.connId)).toHaveLength(1);
      expect(await importedBookings(two.connId)).toHaveLength(1);
    });

    it('counts a broken feed and still finishes the healthy ones', async () => {
      const token = await freshOwner();
      const healthy = await connectUnit(token);
      const broken = await connectUnit(token);
      fake.setFeed(
        healthy.feedUrl,
        feedWith([
          { uid: 'mixed-ok', start: daysFromToday(50), end: daysFromToday(52) },
        ]),
      );
      fake.setFeedError(broken.feedUrl, 'Feed is unreachable');

      const body = bodyOf<SyncAllResponse>(await syncAll(token).expect(200));

      // One dead OTA must not hide the results of the others, and must not fail
      // the click: the healthy feed imported, the broken one is a number the
      // owner can chase on the property workbench (which names WHICH feed).
      expect(body).toEqual({
        feeds: 2,
        errored: 1,
        imported: 1,
        cancelled: 0,
        conflicts: 0,
      });
      expect(await importedBookings(healthy.connId)).toHaveLength(1);
      expect(await importedBookings(broken.connId)).toHaveLength(0);
    });

    it('never touches another tenant’s feeds', async () => {
      const mineToken = await freshOwner();
      const theirsToken = await freshOwner();
      const mine = await connectUnit(mineToken);
      const theirs = await connectUnit(theirsToken);
      fake.setFeed(
        mine.feedUrl,
        feedWith([
          { uid: 'iso-mine', start: daysFromToday(60), end: daysFromToday(62) },
        ]),
      );
      fake.setFeed(
        theirs.feedUrl,
        feedWith([
          {
            uid: 'iso-theirs',
            start: daysFromToday(60),
            end: daysFromToday(62),
          },
        ]),
      );
      fake.calls.length = 0;

      await syncAll(mineToken).expect(200);

      // Not "B imported nothing" (which a shared UID could fake) but the stronger
      // claim: B's URL was never fetched at all. Scope is RLS's answer, so a
      // caller cannot reach a feed they could not open one at a time.
      expect(fake.calls).toContain(mine.feedUrl);
      expect(fake.calls).not.toContain(theirs.feedUrl);
      expect(await importedBookings(theirs.connId)).toHaveLength(0);
    });

    it('answers cleanly for a tenant with no connections at all', async () => {
      // Nothing wired: `feeds: 0` is a real answer ("connect an OTA first"), not
      // an error and not an empty success that reads as "synced".
      const body = bodyOf<SyncAllResponse>(
        await syncAll(await freshOwner()).expect(200),
      );
      expect(body).toEqual({
        feeds: 0,
        errored: 0,
        imported: 0,
        cancelled: 0,
        conflicts: 0,
      });
    });

    it('refuses a body, like every other verb-subresource', async () => {
      // #152: a route that reads no body says so, rather than accepting and
      // ignoring one.
      await syncAll().send({ unitId: 'nope' }).expect(400);
    });
  });
});
