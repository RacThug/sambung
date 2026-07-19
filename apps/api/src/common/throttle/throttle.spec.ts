import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../../app.module';

/**
 * Rate limiting on the abuse-prone surface (api-spec §8.3, #59).
 *
 * The suite's `.env` sets the sensitive limit effectively OFF (like the default
 * tier) so the other specs - which log in and book repeatedly - aren't 429'd. This
 * file drops it to a tiny number BEFORE compiling its own app, then fires
 * `limit + 1` requests and asserts the last is throttled. No sleeping, no waiting
 * for a window: hitting the CEILING is instant, so the suite stays fast.
 *
 * Each sensitive route keeps its OWN per-handler bucket, so login/register/public-
 * booking are proven independently in one app instance.
 */
describe('Rate limiting (api-spec §8.3)', () => {
  const LIMIT = 3;
  let app: INestApplication;
  let originalLimit: string | undefined;
  let originalTtl: string | undefined;

  const server = () => app.getHttpServer() as Server;

  /** Fire n sequential requests, returning each status. Sequential (not parallel)
   * so the counter increments deterministically 1..n against a shared IP tracker. */
  async function fire(n: number, send: () => request.Test): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await send();
      statuses.push(res.status);
    }
    return statuses;
  }

  beforeAll(async () => {
    // Drop the sensitive limit for THIS app only; the factory reads it at compile.
    originalLimit = process.env.THROTTLE_SENSITIVE_LIMIT;
    originalTtl = process.env.THROTTLE_SENSITIVE_TTL_MS;
    process.env.THROTTLE_SENSITIVE_LIMIT = String(LIMIT);
    process.env.THROTTLE_SENSITIVE_TTL_MS = '60000';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    // Restore so a later spec in the same worker isn't throttled.
    if (originalLimit === undefined)
      delete process.env.THROTTLE_SENSITIVE_LIMIT;
    else process.env.THROTTLE_SENSITIVE_LIMIT = originalLimit;
    if (originalTtl === undefined) delete process.env.THROTTLE_SENSITIVE_TTL_MS;
    else process.env.THROTTLE_SENSITIVE_TTL_MS = originalTtl;
  });

  it('throttles login past the limit, and the 429 body follows the error envelope', async () => {
    const statuses = await fire(LIMIT + 1, () =>
      request(server())
        .post('/api/auth/login')
        .send({ email: 'nobody@test.dev', password: 'wrongpass1' }),
    );
    // The first LIMIT are answered (wrong creds → 401), the next is throttled.
    expect(statuses.slice(0, LIMIT).every((s) => s !== 429)).toBe(true);
    expect(statuses[LIMIT]).toBe(429);

    // The 429 must look like every other refusal: { statusCode, error, message }.
    const blocked = await request(server())
      .post('/api/auth/login')
      .send({ email: 'nobody@test.dev', password: 'wrongpass1' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      error: 'Too Many Requests',
    });
    expect(typeof (blocked.body as { message: unknown }).message).toBe(
      'string',
    );
    // Retry-After header rides along (set by the base guard before we rethrow).
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('throttles register past the limit', async () => {
    // Invalid body (400) still counts - the guard runs before the validation pipe -
    // so nothing is written to the DB while we prove the ceiling.
    const statuses = await fire(LIMIT + 1, () =>
      request(server())
        .post('/api/auth/register')
        .send({ tenantName: '', email: 'not-an-email', password: 'x' }),
    );
    expect(statuses.slice(0, LIMIT).every((s) => s !== 429)).toBe(true);
    expect(statuses[LIMIT]).toBe(429);
  });

  it('throttles the public booking write past the limit', async () => {
    const statuses = await fire(LIMIT + 1, () =>
      request(server()).post('/api/public/bookings').send({ bad: 'body' }),
    );
    expect(statuses.slice(0, LIMIT).every((s) => s !== 429)).toBe(true);
    expect(statuses[LIMIT]).toBe(429);
  });

  it('does NOT apply the tight limit to an ordinary route', async () => {
    // health is not @ThrottleSensitive, so the sensitive throttler is skipped; the
    // default tier is high (test env), so a burst well past LIMIT all pass.
    const statuses = await fire(LIMIT + 3, () =>
      request(server()).get('/api/health'),
    );
    expect(statuses.every((s) => s !== 429)).toBe(true);
  });
});
