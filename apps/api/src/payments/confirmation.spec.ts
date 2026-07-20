import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { booking, payment, property, tenant, unit } from '@sambung/db';
import type {
  AuthResponse,
  BookingConfirmationResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { PublicScope } from '../common/public-scope.service';
import { TenantContext } from '../common/tenant-context.service';
import { DbService } from '../db/db.service';
import { TenantDbService } from '../db/tenant-db.service';
import {
  MAILER,
  type EmailMessage,
  type Mailer,
} from '../notifications/mailer';
import { testSlug } from '../test-helpers';
import type { FakeWebhookBody } from './fake-payment.gateway';
import { FakePaymentGateway } from './fake-payment.gateway';
import { PAYMENT_GATEWAY } from './payment-gateway';
import { PaymentsRepository } from './payments.repository';

/** Records what would have been emailed, so a test can prove "exactly once".
 * `fail` makes every `send` reject, to prove a down mailer never breaks the flow.
 * `failRecipient` rejects only ONE address (a bounced recipient), to prove
 * per-recipient isolation (#126): the other recipient is still emailed. */
class RecordingMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  fail = false;
  failRecipient: string | null = null;
  send(message: EmailMessage): Promise<void> {
    if (this.fail || message.to === this.failRecipient) {
      return Promise.reject(new Error('mailer is down'));
    }
    this.sent.push(message);
    return Promise.resolve();
  }
}

/**
 * The confirmation page - `GET /public/bookings/:id`, reconcile-on-read (#54,
 * api-spec §6.3, risk R3). Real Postgres so the RLS-scoped view, the owner-
 * connection reconcile, and the shared idempotent confirm are all genuinely
 * exercised. The Provider is the fake bound over PAYMENT_GATEWAY (its status map
 * simulates a settlement no webhook delivered); the mailer is a recording fake, so
 * "email exactly once" is an assertion, not a log grep. No suite reaches live
 * Midtrans or sends a real email.
 */
describe('Confirmation page (reconcile-on-read)', () => {
  let app: INestApplication;
  let dbs: DbService;
  const fake = new FakePaymentGateway();
  const mailer = new RecordingMailer();
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  let tenantAId: string;
  let tenantBId: string;
  let unitId: string;

  const getConfirmation = (bookingId: string) =>
    request(server()).get(`/api/public/bookings/${bookingId}`);
  const deliverWebhook = (body: object) =>
    request(server()).post('/api/webhooks/payment/midtrans').send(body);

  // Distinct dates per booking so occupying rows never collide on the exclusion
  // constraint - the suite shares one unit and never cleans up between tests.
  let stayOffset = 0;
  const uniqueStay = (): { checkIn: string; checkOut: string } => {
    const start = new Date(Date.UTC(2029, 0, 10 + stayOffset));
    stayOffset += 6;
    const end = new Date(start.getTime() + 4 * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { checkIn: iso(start), checkOut: iso(end) };
  };

  const seedBooking = (values: {
    status?: 'pending_payment' | 'confirmed' | 'expired' | 'cancelled';
    holdExpiresAt?: Date | null;
    totalPriceIdr?: bigint | null;
    guestPhone?: string | null;
    guestEmail?: string | null;
  }) => {
    const { checkIn, checkOut } = uniqueStay();
    return dbs.db
      .insert(booking)
      .values({
        tenantId: tenantAId,
        unitId,
        source: 'direct',
        status: values.status ?? 'pending_payment',
        checkIn,
        checkOut,
        guestName: 'Made A.',
        guestPhone:
          values.guestPhone === undefined
            ? '+6281234567890' // stored E.164 (#54)
            : values.guestPhone,
        guestEmail:
          values.guestEmail === undefined ? 'made@test.dev' : values.guestEmail,
        guestCount: 2,
        totalPriceIdr:
          values.totalPriceIdr === undefined
            ? 4_000_000n
            : values.totalPriceIdr,
        holdExpiresAt:
          values.holdExpiresAt === undefined
            ? new Date(Date.now() + 15 * 60_000)
            : values.holdExpiresAt,
      })
      .returning({ id: booking.id })
      .then((rows) => rows[0].id);
  };

  const seedPayment = (bookingId: string, amountIdr = 1_200_000n) => {
    const id = randomUUID();
    return dbs.db
      .insert(payment)
      .values({
        id,
        bookingId,
        provider: 'midtrans',
        providerRef: id,
        amountIdr,
        status: 'pending',
        rawPayload: { token: `tok-${id}`, redirectUrl: 'https://x/y' },
      })
      .returning({ id: payment.id })
      .then((rows) => rows[0].id);
  };

  /** A live guest-hold + pending-payment pair, ready to settle (deposit 1.2M). */
  const seedPayable = async (amountIdr = 1_200_000n) => {
    const bookingId = await seedBooking({});
    const orderId = await seedPayment(bookingId, amountIdr);
    return { bookingId, orderId };
  };

  const settlement = (
    orderId: string,
    over: Partial<FakeWebhookBody> = {},
  ): FakeWebhookBody => ({
    orderId,
    transactionId: `txn-${randomUUID()}`,
    transactionStatus: 'settlement',
    grossAmountIdr: 1_200_000,
    ...over,
  });

  const statusOfBooking = (id: string) =>
    dbs.db
      .select({ status: booking.status })
      .from(booking)
      .where(eq(booking.id, id))
      .then((r) => r[0]?.status);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(fake)
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);

    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: 'Confirm Tenant A',
        email: `cf+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      });
    tenantAId = bodyOf<AuthResponse>(res).tenant.id;
    createdTenantIds.push(tenantAId);

    const [prop] = await dbs.db
      .insert(property)
      .values({ tenantId: tenantAId, name: 'CF Villa', slug: testSlug() })
      .returning({ id: property.id });
    const [u] = await dbs.db
      .insert(unit)
      .values({
        propertyId: prop.id,
        tenantId: tenantAId,
        name: 'CF Room',
        basePriceIdr: 1_000_000n,
      })
      .returning({ id: unit.id });
    unitId = u.id;

    // A second tenant, for the cross-tenant isolation test (D).
    const resB = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: 'Confirm Tenant B',
        email: `cf+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      });
    tenantBId = bodyOf<AuthResponse>(resB).tenant.id;
    createdTenantIds.push(tenantBId);
  });

  afterEach(() => {
    mailer.sent.length = 0;
    mailer.fail = false;
    mailer.failRecipient = null;
    fake.statuses.clear();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  // --- AC (b): page load alone confirms, even with no webhook ever delivered ---

  it('confirms on read by reconciling against the provider (no webhook)', async () => {
    const { bookingId, orderId } = await seedPayable();
    // The provider says settled, but NO webhook was delivered (it was lost).
    fake.setStatus(orderId, settlement(orderId));

    const res = await getConfirmation(bookingId);
    expect(res.status).toBe(200);
    const view = bodyOf<BookingConfirmationResponse>(res);
    expect(view.status).toBe('confirmed');
    expect(view.amountPaidIdr).toBe(1_200_000);

    // The reconcile persisted, not just the response: booking confirmed in the DB.
    expect(await statusOfBooking(bookingId)).toBe('confirmed');
  });

  // --- AC (c): email fires exactly once per confirmation, idempotent ----------

  it('emails guest + owner once on the reconcile-confirm, and never again', async () => {
    const { bookingId, orderId } = await seedPayable();
    fake.setStatus(orderId, settlement(orderId));

    await getConfirmation(bookingId).expect(200);
    // One confirmation → two emails (guest + owner).
    expect(mailer.sent).toHaveLength(2);
    const recipients = mailer.sent.map((m) => m.to);
    expect(recipients).toContain('made@test.dev'); // the guest
    expect(recipients.some((r) => r.startsWith('cf+'))).toBe(true); // the tenant owner

    // A second read (still-settled provider) must NOT re-confirm or re-email:
    // the booking is already confirmed, so reconcile-on-read no-ops.
    await getConfirmation(bookingId).expect(200);
    expect(mailer.sent).toHaveLength(2);
  });

  it('does not re-email when a webhook already confirmed (duplicate-safe)', async () => {
    const { bookingId, orderId } = await seedPayable();
    // Webhook path confirms + emails once.
    await deliverWebhook(settlement(orderId)).expect(200);
    expect(mailer.sent).toHaveLength(2);

    // Reconcile-on-read finds it already terminal → no second confirmation email.
    const res = await getConfirmation(bookingId).expect(200);
    expect(bodyOf<BookingConfirmationResponse>(res).status).toBe('confirmed');
    expect(mailer.sent).toHaveLength(2);
  });

  // --- AC (a) support: a truly-pending booking reads pending, doesn't confirm --

  it('stays pending when the provider has no settlement yet', async () => {
    const { bookingId } = await seedPayable();
    // No status staged → fake.fetchStatus returns null (provider has no record).
    const res = await getConfirmation(bookingId).expect(200);
    expect(bodyOf<BookingConfirmationResponse>(res).status).toBe(
      'pending_payment',
    );
    expect(mailer.sent).toHaveLength(0);
  });

  // --- AC (e): expired / cancelled render; unknown id → 404 -------------------

  it('shows expired once a lapsed, unpaid hold is swept on read', async () => {
    const bookingId = await seedBooking({
      holdExpiresAt: new Date(Date.now() - 60_000), // lapsed, still pending in DB
    });
    await seedPayment(bookingId); // a session exists, but the provider never settled

    const res = await getConfirmation(bookingId).expect(200);
    expect(bodyOf<BookingConfirmationResponse>(res).status).toBe('expired');
    // The read persisted the sweep.
    expect(await statusOfBooking(bookingId)).toBe('expired');
    expect(mailer.sent).toHaveLength(0);
  });

  it('renders a cancelled booking without touching it', async () => {
    const bookingId = await seedBooking({ status: 'cancelled' });
    const res = await getConfirmation(bookingId).expect(200);
    expect(bodyOf<BookingConfirmationResponse>(res).status).toBe('cancelled');
    expect(await statusOfBooking(bookingId)).toBe('cancelled');
  });

  it('404s an unknown booking id', async () => {
    await getConfirmation(randomUUID()).expect(404);
  });

  it('400s a non-UUID id before any lookup', async () => {
    await getConfirmation('not-a-uuid').expect(400);
  });

  // --- FR-NOTIF-2: the wa.me deeplink -----------------------------------------

  it('returns a prefilled wa.me deeplink to the guest number', async () => {
    const bookingId = await seedBooking({ status: 'confirmed' });
    const res = await getConfirmation(bookingId).expect(200);
    const view = bodyOf<BookingConfirmationResponse>(res);
    expect(view.waLink).toContain('https://wa.me/6281234567890');
    expect(view.waLink).toContain('text=');
  });

  it('returns a null waLink when the booking has no phone', async () => {
    const bookingId = await seedBooking({
      status: 'confirmed',
      guestPhone: null,
    });
    const res = await getConfirmation(bookingId).expect(200);
    expect(bodyOf<BookingConfirmationResponse>(res).waLink).toBeNull();
  });

  it('omits the wa.me link for a walk-in phone that is not E.164 (#123 review)', async () => {
    // Owner walk-ins use the LENIENT phone schema, so a bare national number can be
    // stored. Read through this endpoint it must yield a null waLink - never the
    // broken wa.me/0812... - so the confirmation view omits the button.
    const bookingId = await seedBooking({
      status: 'confirmed',
      guestPhone: '0812 3456 7890',
    });
    const res = await getConfirmation(bookingId).expect(200);
    expect(bodyOf<BookingConfirmationResponse>(res).waLink).toBeNull();
  });

  // --- Late settlement: money in but the hold lapsed → never resurrected -------

  it('never resurrects an expired booking on a late reconcile, and does not email', async () => {
    const bookingId = await seedBooking({
      status: 'expired',
      holdExpiresAt: new Date(Date.now() - 60_000),
    });
    // No pending payment row (already terminal), so reconcile-on-read reads the
    // terminal status and does nothing - the booking is not dragged back.
    const res = await getConfirmation(bookingId).expect(200);
    expect(bodyOf<BookingConfirmationResponse>(res).status).toBe('expired');
    expect(await statusOfBooking(bookingId)).toBe('expired');
    expect(mailer.sent).toHaveLength(0);
  });

  // --- (B) A throwing mailer must never break the confirmation flow -----------

  it('confirms (and returns 200) even when the mailer throws - best-effort seam', async () => {
    const { bookingId, orderId } = await seedPayable();
    fake.setStatus(orderId, settlement(orderId));
    mailer.fail = true; // the email provider is down

    // The post-commit email fails, but the confirmation must still succeed.
    const res = await getConfirmation(bookingId).expect(200);
    expect(bodyOf<BookingConfirmationResponse>(res).status).toBe('confirmed');
    // And it persisted: the booking is genuinely confirmed, not just in the body.
    expect(await statusOfBooking(bookingId)).toBe('confirmed');
    // The send threw, so nothing was recorded - proving the throw was swallowed.
    expect(mailer.sent).toHaveLength(0);
  });

  // --- (#126) One recipient bouncing must not drop the other -------------------

  it('still emails the owner when the GUEST send bounces (per-recipient isolation)', async () => {
    const { bookingId, orderId } = await seedPayable();
    fake.setStatus(orderId, settlement(orderId));
    mailer.failRecipient = 'made@test.dev'; // only the guest's address bounces

    // The confirmation still succeeds and persists...
    const res = await getConfirmation(bookingId).expect(200);
    expect(bodyOf<BookingConfirmationResponse>(res).status).toBe('confirmed');
    expect(await statusOfBooking(bookingId)).toBe('confirmed');

    // ...and the owner's new-booking email STILL went out despite the guest bounce
    // (before #126 the guest failure aborted the loop and dropped this).
    const recipients = mailer.sent.map((m) => m.to);
    expect(recipients).not.toContain('made@test.dev'); // guest bounced
    expect(recipients.some((r) => r.startsWith('cf+'))).toBe(true); // owner got it
  });

  // --- (D) The confirmation read is confined to the booking's tenant (RLS) ----

  it("scopes the confirmation read to the booking's own tenant - never another", async () => {
    const bookingId = await seedBooking({ status: 'confirmed' }); // tenant A's

    const cls = app.get(ClsService);
    const scope = app.get(PublicScope);
    const tenantCtx = app.get(TenantContext);
    const tenantDb = app.get(TenantDbService);
    const repo = app.get(PaymentsRepository);

    // Under tenant B's scope, tenant A's booking is invisible - RLS + the tenant
    // WHERE block it even when read by its exact id.
    const underB = await cls.run(async () => {
      tenantCtx.set({ kind: 'visitor', tenantId: tenantBId });
      return tenantDb.run(() => repo.readConfirmationView(bookingId));
    });
    expect(underB).toBeNull();

    // The resolver always confines to the booking's OWN tenant, so the real route
    // reads it fine - isolation is inherent, not a check that could be skipped.
    const underOwn = await cls.run(async () => {
      await scope.enterFromBookingId(bookingId);
      return tenantDb.run(() => repo.readConfirmationView(bookingId));
    });
    expect(underOwn).not.toBeNull();
  });
});
