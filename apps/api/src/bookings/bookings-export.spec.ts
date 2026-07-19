import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { inArray } from 'drizzle-orm';
import request from 'supertest';
import { booking, property, tenant, unit } from '@sambung/db';
import type { AuthResponse } from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { testSlug } from '../test-helpers';

/**
 * The reservations CSV export - GET /bookings/export.csv (api-spec §5.5 CSV twin,
 * #59). Real Postgres, real HTTP. Proves the AC end-to-end: the export respects the
 * SAME active filters as the list, integer IDR crosses unmangled, a comma/quote in
 * a guest name is escaped so the file opens cleanly, and - because it is a
 * tenant-owned read - another tenant's rows never appear even when named.
 */
describe('GET /bookings/export.csv (reservations CSV export)', () => {
  let app: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;

  let tokenA: string;
  let tenantAId: string;
  let tenantBId: string;
  let uStdId: string; // A's unit
  let uBId: string; // B's unit

  const seed = (values: {
    tenantId: string;
    unitId: string;
    status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired';
    checkIn: string;
    checkOut: string;
    source?: 'direct' | 'manual_block';
    guestName?: string | null;
    guestCount?: number | null;
    totalPriceIdr?: bigint | null;
  }) =>
    dbs.db
      .insert(booking)
      .values({
        tenantId: values.tenantId,
        unitId: values.unitId,
        source: values.source ?? 'direct',
        status: values.status,
        checkIn: values.checkIn,
        checkOut: values.checkOut,
        guestName: values.guestName ?? null,
        guestCount: values.guestCount ?? null,
        totalPriceIdr: values.totalPriceIdr ?? null,
      })
      .returning({ id: booking.id })
      .then((rows) => rows[0].id);

  const exportAs = (token: string, query: Record<string, unknown> = {}) =>
    request(server())
      .get('/api/bookings/export.csv')
      .set('Authorization', `Bearer ${token}`)
      .query(query);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);

    const registerTenant = async (name: string) => {
      const res = await request(server())
        .post('/api/auth/register')
        .send({
          tenantName: name,
          email: `csv+${randomUUID()}@test.dev`,
          password: 'supersecret1',
        });
      return res.body as AuthResponse;
    };

    const a = await registerTenant('CSV Tenant A');
    const b = await registerTenant('CSV Tenant B');
    tokenA = a.accessToken;
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;
    createdTenantIds.push(tenantAId, tenantBId);

    const [pA, pB] = await dbs.db
      .insert(property)
      .values([
        { tenantId: tenantAId, name: 'Seminyak Villa', slug: testSlug() },
        { tenantId: tenantBId, name: 'B Villa', slug: testSlug() },
      ])
      .returning({ id: property.id });

    const [uStd, uB] = await dbs.db
      .insert(unit)
      .values([
        {
          propertyId: pA.id,
          tenantId: tenantAId,
          name: 'Garden Room 1',
          basePriceIdr: 1_000_000n,
        },
        {
          propertyId: pB.id,
          tenantId: tenantBId,
          name: 'B Room',
          basePriceIdr: 1_000_000n,
        },
      ])
      .returning({ id: unit.id });
    uStdId = uStd.id;
    uBId = uB.id;

    await Promise.all([
      // A confirmed stay with a comma in the guest name + a large exact price.
      seed({
        tenantId: tenantAId,
        unitId: uStdId,
        status: 'confirmed',
        checkIn: '2027-03-10',
        checkOut: '2027-03-14',
        guestName: 'Smith, John',
        guestCount: 2,
        totalPriceIdr: 1_500_000_000n,
      }),
      // A cancelled stay - present in an unfiltered export, gone under a status filter.
      seed({
        tenantId: tenantAId,
        unitId: uStdId,
        status: 'cancelled',
        checkIn: '2027-03-20',
        checkOut: '2027-03-22',
        guestName: 'Cancelled Cathy',
        guestCount: 1,
        totalPriceIdr: 2_000_000n,
      }),
      // B's row on the same dates as A's - must NEVER appear in A's export.
      seed({
        tenantId: tenantBId,
        unitId: uBId,
        status: 'confirmed',
        checkIn: '2027-03-10',
        checkOut: '2027-03-14',
        guestName: 'Other Tenant Guest',
        guestCount: 2,
        totalPriceIdr: 9_000_000n,
      }),
    ]);
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  it('serves text/csv as an attachment', async () => {
    const res = await exportAs(tokenA);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    // Header row present.
    expect(res.text).toContain('Booking ID,Property,Unit,Guest');
  });

  it('emits integer IDR unmangled - the exact digits, no float / e-notation', () => {
    return exportAs(tokenA).then((res) => {
      // The 1,500,000,000 rupiah row shows exact digits, never 1.5E+9.
      expect(res.text).toContain('1500000000');
      expect(res.text).not.toMatch(/1\.5[eE]\+?9/);
    });
  });

  it('escapes a comma in a guest name so the columns stay aligned', async () => {
    const res = await exportAs(tokenA);
    expect(res.text).toContain('"Smith, John"');
  });

  it('respects the SAME active filters as the list (status filter)', async () => {
    const all = await exportAs(tokenA);
    expect(all.text).toContain('Cancelled Cathy'); // unfiltered: cancelled shows

    const confirmedOnly = await exportAs(tokenA, { status: 'confirmed' });
    expect(confirmedOnly.text).toContain('Smith, John');
    expect(confirmedOnly.text).not.toContain('Cancelled Cathy');
  });

  it("never exports another tenant's rows, even when its unit id is named", async () => {
    const res = await exportAs(tokenA, { unitId: uBId });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Other Tenant Guest');
    // Only the header row survives - RLS + WHERE tenant_id return nothing.
    expect(res.text.trim().split('\r\n')).toHaveLength(1);
  });

  it('rejects an unauthenticated export with 401', async () => {
    const res = await request(server()).get('/api/bookings/export.csv');
    expect(res.status).toBe(401);
  });

  it('rejects a lone `from` (a bad window) with 400 - same validation as the list', async () => {
    const res = await exportAs(tokenA, { from: '2027-03-01' });
    expect(res.status).toBe(400);
  });
});
