import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import {
  booking,
  payment,
  property,
  tenant,
  tenantPaymentCredential,
  unit,
} from '@sambung/db';
import type {
  AuthResponse,
  PaymentCredentialStatusResponse,
  PublicPropertyResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import {
  MAILER,
  type EmailMessage,
  type Mailer,
} from '../notifications/mailer';
import { insertCredentialFixture, testSlug } from '../test-helpers';
import { decryptCredential } from './credential-crypto';
import { CredentialResolver } from './credential-resolver.service';
import { rotateCredentials } from './credential-rotation';
import { FakePaymentGateway } from './fake-payment.gateway';
import { PAYMENT_GATEWAY } from './payment-gateway';

/**
 * Per-tenant payment credentials (REQ-PA-04, ADR-0039, EARS
 * docs/spec/tenant-payments.md), over real HTTP + DB + the REAL crypto.
 *
 * TWO app instances on purpose:
 *  - `app` binds the FakePaymentGateway (verify-on-save without an outbound
 *    call) - the credential LIFECYCLE (CR-01..05) and the encrypt→store→decrypt
 *    round trip run here;
 *  - `realApp` keeps the default MidtransGateway binding - the funnel gates
 *    (GW-02/03/04) fire BEFORE any network call, and the webhook's
 *    resolve-tenant-first ordering (WH-01) is proven with the real SHA512
 *    against keys stored through the real encryption.
 */
describe('Payment credentials (REQ-PA-04)', () => {
  let app: INestApplication;
  let realApp: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];
  const sent: EmailMessage[] = [];
  const fakeMailer: Mailer = {
    send: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
  };
  const fakeGateway = new FakePaymentGateway();

  const server = () => app.getHttpServer() as Server;
  const realServer = () => realApp.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function registerTenant(name: string) {
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: name,
        email: `cred+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      })
      .expect(201);
    const body = bodyOf<AuthResponse>(res);
    createdTenantIds.push(body.tenant.id);
    return body;
  }

  const putCredential = (
    token: string,
    body: Record<string, unknown>,
    provider = 'midtrans',
  ) =>
    request(server())
      .put(`/api/settings/payment-credentials/${provider}`)
      .set(auth(token))
      .send(body);

  beforeAll(async () => {
    const fakeRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(fakeGateway)
      .overrideProvider(MAILER)
      .useValue(fakeMailer)
      .compile();
    app = fakeRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);

    const realRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    realApp = realRef.createNestApplication();
    realApp.setGlobalPrefix('api');
    realApp.use(cookieParser());
    await realApp.init();
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
    await realApp.close();
  });

  beforeEach(() => {
    fakeGateway.verifyOutcome = 'ok';
  });

  describe('lifecycle (EARS CR-01..04)', () => {
    it('saves, lists, and NEVER returns the key in any form (CR-02)', async () => {
      const owner = await registerTenant('Cred Lifecycle');
      const rawKey = `SB-Mid-server-${randomUUID()}`;

      const saved = await putCredential(owner.accessToken, {
        serverKey: rawKey,
        environment: 'sandbox',
      }).expect(200);
      const status = bodyOf<PaymentCredentialStatusResponse>(saved);
      expect(status).toMatchObject({
        provider: 'midtrans',
        environment: 'sandbox',
        lastVerifyStatus: 'ok',
      });
      // The write-only guarantee, asserted on the BYTES of both responses: the
      // raw key appears nowhere, under any field name.
      expect(JSON.stringify(saved.body)).not.toContain(rawKey);

      const listed = await request(server())
        .get('/api/settings/payment-credentials')
        .set(auth(owner.accessToken))
        .expect(200);
      expect(bodyOf<PaymentCredentialStatusResponse[]>(listed)).toHaveLength(1);
      expect(JSON.stringify(listed.body)).not.toContain(rawKey);
    });

    it('replace is the same idempotent PUT: one row, new environment (CR-01/04)', async () => {
      const owner = await registerTenant('Cred Replace');
      await putCredential(owner.accessToken, {
        serverKey: 'SB-Mid-server-first',
        environment: 'sandbox',
      }).expect(200);
      const replaced = await putCredential(owner.accessToken, {
        serverKey: 'Mid-server-second',
        environment: 'production',
      }).expect(200);
      expect(
        bodyOf<PaymentCredentialStatusResponse>(replaced).environment,
      ).toBe('production');
      const rows = await dbs.db
        .select({ id: tenantPaymentCredential.id })
        .from(tenantPaymentCredential)
        .where(eq(tenantPaymentCredential.tenantId, owner.tenant.id));
      expect(rows).toHaveLength(1);
    });

    it('a failed verify STORES with the outcome - never a refusal (CR-03)', async () => {
      const owner = await registerTenant('Cred Verify Fail');
      fakeGateway.verifyOutcome = 'failed';
      const saved = await putCredential(owner.accessToken, {
        serverKey: 'SB-Mid-server-wrong-or-unreachable',
        environment: 'sandbox',
      }).expect(200);
      expect(
        bodyOf<PaymentCredentialStatusResponse>(saved).lastVerifyStatus,
      ).toBe('failed');
    });

    it('rejects an unknown provider (404) and a malformed body (400)', async () => {
      const owner = await registerTenant('Cred Validation');
      await putCredential(
        owner.accessToken,
        { serverKey: 'SB-Mid-server-x', environment: 'sandbox' },
        'xendit',
      ).expect(404);
      await putCredential(owner.accessToken, {
        serverKey: 'short',
        environment: 'sandbox',
      }).expect(400);
      await putCredential(owner.accessToken, {
        serverKey: 'SB-Mid-server-x',
        environment: 'staging',
      }).expect(400);
      await putCredential(owner.accessToken, {
        serverKey: 'SB-Mid-server-x',
        environment: 'sandbox',
        serverKye: 'typo',
      }).expect(400);
    });

    it('is owner-only in BOTH directions: staff get 403 on read and write (CR-05)', async () => {
      const owner = await registerTenant('Cred Roles');
      // A real staff seat, made the way a real invitee makes one (ADR-0033: the
      // token exists only in the email).
      const [prop] = await dbs.db
        .insert(property)
        .values({
          tenantId: owner.tenant.id,
          name: 'Cred Villa',
          slug: testSlug(),
        })
        .returning({ id: property.id });
      const before = sent.length;
      await request(server())
        .post('/api/auth/invites')
        .set(auth(owner.accessToken))
        .send({
          email: `cred-staff+${randomUUID()}@test.dev`,
          propertyIds: [prop.id],
        })
        .expect(201);
      const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(sent[before].text)![1];
      const accepted = await request(server())
        .post('/api/auth/invites/accept')
        .send({ token, password: 'supersecret1' })
        .expect(200);
      const staffToken = bodyOf<AuthResponse>(accepted).accessToken;

      await request(server())
        .get('/api/settings/payment-credentials')
        .set(auth(staffToken))
        .expect(403);
      await putCredential(staffToken, {
        serverKey: 'SB-Mid-server-smuggled',
        environment: 'sandbox',
      }).expect(403);
    });

    it('what the PUT stored, the resolver decrypts back - and a seed-format row too (CR-06, MIG-01)', async () => {
      const owner = await registerTenant('Cred Roundtrip');
      const rawKey = `SB-Mid-server-${randomUUID()}`;
      await putCredential(owner.accessToken, {
        serverKey: rawKey,
        environment: 'production',
      }).expect(200);

      const resolver = app.get(CredentialResolver);
      const resolved = await resolver.maybeResolve(owner.tenant.id);
      expect(resolved).toEqual({
        serverKey: rawKey,
        environment: 'production',
      });

      // The seed encrypts INLINE (packages/db cannot import this app); this is
      // the assertion that pins the two formats together. Same construction as
      // seed.ts, decrypted by the app's own resolver.
      const seedTenant = await registerTenant('Cred Seed Format');
      const seedKey = `SB-Mid-server-seeded-${randomUUID()}`;
      const appKey = Buffer.from(
        process.env.CREDENTIAL_ENCRYPTION_KEY ?? '',
        'base64',
      );
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', appKey, nonce);
      const ciphertext = Buffer.concat([
        cipher.update(seedKey, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      await dbs.db.insert(tenantPaymentCredential).values({
        tenantId: seedTenant.tenant.id,
        provider: 'midtrans',
        environment: 'sandbox',
        ciphertext,
        nonce,
      });
      const seedResolved = await resolver.maybeResolve(seedTenant.tenant.id);
      expect(seedResolved?.serverKey).toBe(seedKey);
    });
  });

  describe('key rotation (EARS MIG-03, docs/runbooks/credential-key.md)', () => {
    it('re-encrypts under the new key, bumps the generation, and a re-run is a no-op', async () => {
      const owner = await registerTenant('Cred Rotation');
      const rawKey = `SB-Mid-server-rotate-${randomUUID()}`;
      await putCredential(owner.accessToken, {
        serverKey: rawKey,
        environment: 'sandbox',
      }).expect(200);

      const oldKey = Buffer.from(
        process.env.CREDENTIAL_ENCRYPTION_KEY ?? '',
        'base64',
      );
      const newKey = randomBytes(32);

      const first = await rotateCredentials(dbs.db, oldKey, newKey, 1);
      expect(first.newVersion).toBe(2);
      expect(first.rotated).toBeGreaterThanOrEqual(1);

      const [row] = await dbs.db
        .select({
          ciphertext: tenantPaymentCredential.ciphertext,
          nonce: tenantPaymentCredential.nonce,
          keyVersion: tenantPaymentCredential.keyVersion,
        })
        .from(tenantPaymentCredential)
        .where(eq(tenantPaymentCredential.tenantId, owner.tenant.id));
      expect(row.keyVersion).toBe(2);
      // The old key can no longer read it; the new one recovers the exact key.
      expect(() =>
        decryptCredential(row.ciphertext, row.nonce, oldKey),
      ).toThrow();
      expect(decryptCredential(row.ciphertext, row.nonce, newKey)).toBe(rawKey);

      // Resumability: a second pass finds every row already on generation 2.
      const second = await rotateCredentials(dbs.db, oldKey, newKey, 1);
      expect(second.rotated).toBe(0);
    });
  });

  describe('the funnel gates, real gateway bound (EARS GW-02/03/04)', () => {
    async function seedFunnel(tenantId: string) {
      const [prop] = await dbs.db
        .insert(property)
        .values({ tenantId, name: 'Gate Villa', slug: testSlug() })
        .returning({ id: property.id, slug: property.slug });
      const [u] = await dbs.db
        .insert(unit)
        .values({
          tenantId,
          propertyId: prop.id,
          name: 'Gate Room',
          basePriceIdr: 1_000_000n,
        })
        .returning({ id: unit.id });
      return { slug: prop.slug, unitId: u.id };
    }

    const daysFromToday = (days: number): string => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      return d.toISOString().slice(0, 10);
    };

    it('no credential: the flag is false, the booking write and pay answer 409; a credential flips all three', async () => {
      const owner = await registerTenant('Gate Tenant');
      const { slug, unitId } = await seedFunnel(owner.tenant.id);

      // GW-04: availability stays honest, checkout is advertised off.
      const before = bodyOf<PublicPropertyResponse>(
        await request(realServer())
          .get(`/api/public/properties/${slug}`)
          .expect(200),
      );
      expect(before.onlinePaymentsAvailable).toBe(false);

      // GW-03: no unpayable 15-minute holds.
      const refused = await request(realServer())
        .post('/api/public/bookings')
        .send({
          unitId,
          checkIn: daysFromToday(10),
          checkOut: daysFromToday(12),
          guestName: 'Gated Guest',
          guestPhone: '+6281234567890',
          guestCount: 2,
        })
        .expect(409);
      expect(refused.body).toMatchObject({ code: 'payments_not_configured' });

      // Existence flips both - the SAME predicate on both surfaces.
      await insertCredentialFixture(dbs.db, owner.tenant.id);
      const after = bodyOf<PublicPropertyResponse>(
        await request(realServer())
          .get(`/api/public/properties/${slug}`)
          .expect(200),
      );
      expect(after.onlinePaymentsAvailable).toBe(true);
      const created = await request(realServer())
        .post('/api/public/bookings')
        .send({
          unitId,
          checkIn: daysFromToday(10),
          checkOut: daysFromToday(12),
          guestName: 'Gated Guest',
          guestPhone: '+6281234567890',
          guestCount: 2,
        })
        .expect(201);
      const bookingId = (created.body as { bookingId: string }).bookingId;

      // GW-02: delete the credential and the pay endpoint refuses with the same
      // slug, BEFORE any gateway call (the real gateway is bound - an outbound
      // call would fail this test loudly).
      await dbs.db
        .delete(tenantPaymentCredential)
        .where(eq(tenantPaymentCredential.tenantId, owner.tenant.id));
      const pay = await request(realServer())
        .post(`/api/public/bookings/${bookingId}/pay`)
        .expect(409);
      expect(pay.body).toMatchObject({ code: 'payments_not_configured' });
    });
  });

  describe('the webhook resolves the tenant first, real crypto (EARS WH-01/03)', () => {
    const KEY_A = 'SB-Mid-server-tenant-A';
    const KEY_B = 'SB-Mid-server-tenant-B';

    const sign = (
      orderId: string,
      statusCode: string,
      gross: string,
      key: string,
    ) =>
      createHash('sha512')
        .update(orderId + statusCode + gross + key)
        .digest('hex');

    const notification = (orderId: string, key: string) => ({
      order_id: orderId,
      status_code: '200',
      gross_amount: '2000000.00',
      transaction_id: `txn-${randomUUID()}`,
      transaction_status: 'settlement',
      signature_key: sign(orderId, '200', '2000000.00', key),
    });

    it("verifies under the RESOLVED tenant's key: its own signature confirms, another tenant's is rejected", async () => {
      // Two tenants, two REAL encrypted credentials (stored via the PUT).
      const ownerA = await registerTenant('Webhook Tenant A');
      const ownerB = await registerTenant('Webhook Tenant B');
      await putCredential(ownerA.accessToken, {
        serverKey: KEY_A,
        environment: 'sandbox',
      }).expect(200);
      await putCredential(ownerB.accessToken, {
        serverKey: KEY_B,
        environment: 'sandbox',
      }).expect(200);

      // A pending hold + payment for tenant A, planted directly (the pay
      // endpoint would call the real gateway outbound).
      const [prop] = await dbs.db
        .insert(property)
        .values({
          tenantId: ownerA.tenant.id,
          name: 'WH Villa',
          slug: testSlug(),
        })
        .returning({ id: property.id });
      const [u] = await dbs.db
        .insert(unit)
        .values({
          tenantId: ownerA.tenant.id,
          propertyId: prop.id,
          name: 'WH Room',
          basePriceIdr: 1_000_000n,
        })
        .returning({ id: unit.id });
      const [b] = await dbs.db
        .insert(booking)
        .values({
          tenantId: ownerA.tenant.id,
          unitId: u.id,
          source: 'direct',
          status: 'pending_payment',
          checkIn: '2027-09-01',
          checkOut: '2027-09-03',
          totalPriceIdr: 2_000_000n,
          holdExpiresAt: new Date(Date.now() + 15 * 60_000),
        })
        .returning({ id: booking.id });
      const paymentId = randomUUID();
      await dbs.db.insert(payment).values({
        id: paymentId,
        bookingId: b.id,
        provider: 'midtrans',
        amountIdr: 2_000_000n,
      });

      // WH-01: signed with tenant B's key for tenant A's order → the resolver
      // picks A's key, the signature reads as forged → 401, nothing recorded.
      await request(realServer())
        .post('/api/webhooks/payment/midtrans')
        .send(notification(paymentId, KEY_B))
        .expect(401);
      const [still] = await dbs.db
        .select({ status: booking.status })
        .from(booking)
        .where(eq(booking.id, b.id));
      expect(still.status).toBe('pending_payment');

      // Signed with A's OWN key: the full resolve→decrypt→verify→confirm chain,
      // end to end with the real SHA512 over a really-encrypted credential.
      await request(realServer())
        .post('/api/webhooks/payment/midtrans')
        .send(notification(paymentId, KEY_A))
        .expect(200);
      const [confirmed] = await dbs.db
        .select({ status: booking.status })
        .from(booking)
        .where(eq(booking.id, b.id));
      expect(confirmed.status).toBe('confirmed');
    });

    it('an unresolvable order id is acked 200 and never verified (WH-02)', async () => {
      await request(realServer())
        .post('/api/webhooks/payment/midtrans')
        .send(notification(randomUUID(), 'any-key-at-all'))
        .expect(200);
    });

    it('a body with no order id is a 400', async () => {
      await request(realServer())
        .post('/api/webhooks/payment/midtrans')
        .send({ transaction_status: 'settlement' })
        .expect(400);
    });
  });
});
