import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Body, INestApplication, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { inArray } from 'drizzle-orm';
import request from 'supertest';
import { tenant } from '@sambung/db';
import type { AuthResponse } from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { NoBodyGuard } from './no-body.guard';

/**
 * A route that takes no body refuses one (#152) - the gap ADR-0031 documented
 * and left open.
 *
 * #150 made every request schema strict, so a misspelled field is a 400 instead
 * of a 200 that changed nothing. But a handler with no `@Body` decorator has no
 * schema to make strict: Nest never reads the body, so `POST /bookings/:id/cancel
 * {"refund":"full"}` answered a cheerful 200 having ignored it. That is the same
 * indistinguishable-from-success failure, on the routes that had nothing to fix.
 *
 * Two things are proven here, and the second is the one that lasts:
 *  - the refusal itself, over real HTTP, on the routes that matter;
 *  - that EVERY mutating route in the app either declares a `@Body` or carries
 *    `@NoBody()`. The marker is per-route by design (greppable, beside `@Roles`),
 *    and the price of that choice is that someone can forget it - so forgetting
 *    fails here instead of shipping. Scope is deliberately wider than #152's
 *    table: DELETE routes take no body either, and `{"force":true}` sent to one
 *    is the same caller bug.
 *
 * The enumeration reads Nest's own route metadata, an internal. That is licensed
 * the way ADR-0026 licenses one: the coupling lives in a TEST, and it fails loudly
 * rather than silently - the `@Body` param key is discovered from a probe class
 * rather than hardcoded, so if the metadata shape ever changes, the probe finds
 * nothing and this suite goes red before anything reaches production.
 */
describe('Routes that take no body refuse one (#152)', () => {
  let app: INestApplication;
  let dbs: DbService;
  let discovery: DiscoveryService;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  const PASSWORD = 'supersecret1';
  let token: string;
  let email: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    await app.init();
    dbs = app.get(DbService);
    discovery = app.get(DiscoveryService);

    email = `nobody+${randomUUID()}@test.dev`;
    const res = await request(server())
      .post('/api/auth/register')
      .send({ tenantName: 'No Body Villas', email, password: PASSWORD })
      .expect(201);
    const auth = bodyOf<AuthResponse>(res);
    token = auth.accessToken;
    createdTenantIds.push(auth.tenant.id);
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  describe('the refusal', () => {
    // The route #152 opens with: cancel is the verb most likely to grow a
    // `reason` or `refund` argument, so a caller guessing at one must be told.
    it('refuses a stray key on POST /bookings/:id/cancel', async () => {
      const res = await request(server())
        .post(`/api/bookings/${randomUUID()}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ refund: 'full' })
        .expect(400);

      // Naming the offending key is the whole point - "something was wrong" is
      // what the old 200 already said, badly.
      expect(JSON.stringify(res.body)).toContain('refund');
    });

    it('refuses before any lookup - a stray key on an unknown id is 400, not 404', async () => {
      // The guard runs ahead of the handler, so the caller learns their body is
      // wrong without the id being resolved. The same id with no body is a 404,
      // which is what makes the body the only difference between these two.
      const id = randomUUID();
      const cancel = () =>
        request(server())
          .post(`/api/bookings/${id}/cancel`)
          .set('Authorization', `Bearer ${token}`);

      await cancel().send({ refund: 'full' }).expect(400);
      await cancel().expect(404);
    });

    it('accepts an empty object as well as an absent body', async () => {
      // Express parses an absent body to `{}`, so the two must be the same
      // answer; a client that sends `{}` is not making a mistake.
      await request(server())
        .post(`/api/bookings/${randomUUID()}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(404);
    });

    it('refuses a stray key on an archive toggle and on a DELETE', async () => {
      await request(server())
        .post(`/api/properties/${randomUUID()}/archive`)
        .set('Authorization', `Bearer ${token}`)
        .send({ cascade: true })
        .expect(400);

      await request(server())
        .delete(`/api/units/${randomUUID()}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ force: true })
        .expect(400);
    });

    it('refuses a stray key on the unauthenticated pay route', async () => {
      // Public surface: no token, so nothing but the guard stands between the
      // request and the service.
      await request(server())
        .post(`/api/public/bookings/${randomUUID()}/pay`)
        .send({ amountIdr: 1 })
        .expect(400);
    });

    it('answers 401 before 400 on an authenticated route', async () => {
      // Controller-level guards run first, so the body is never a hint about
      // whether a session exists.
      await request(server())
        .post(`/api/bookings/${randomUUID()}/cancel`)
        .send({ refund: 'full' })
        .expect(401);
    });
  });

  // AC #4: the SPA's silent 401-retry goes through refresh, so a regression here
  // logs everyone out. It sends no body at all (`api-client.ts` omits both the
  // body and the Content-Type when there is none; `refreshSession` is a raw fetch
  // with only a method), which is exactly the shape asserted below.
  describe('the auth session path still works end to end', () => {
    it('refreshes and logs out with no body', async () => {
      const login = await request(server())
        .post('/api/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      const cookie = login.get('Set-Cookie') ?? [];
      expect(cookie.length).toBeGreaterThan(0);

      const refreshed = await request(server())
        .post('/api/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);
      expect(bodyOf<AuthResponse>(refreshed).accessToken).toBeTruthy();

      await request(server())
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .expect(204);
    });

    it('refuses a stray key on refresh without touching the session', async () => {
      const login = await request(server())
        .post('/api/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      const cookie = login.get('Set-Cookie') ?? [];

      await request(server())
        .post('/api/auth/refresh')
        .set('Cookie', cookie)
        .send({ rotate: false })
        .expect(400);

      // The refusal is a 400 about the request, not a logout: the same cookie
      // still refreshes.
      await request(server())
        .post('/api/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);
    });
  });

  describe('every mutating route declares what it accepts', () => {
    /**
     * The `@Body` param metadata key is `"<paramtype>:<index>"`. Discovering the
     * paramtype from a probe rather than hardcoding it means a Nest change that
     * moves it makes this suite fail rather than quietly classify every route as
     * body-less.
     */
    class BodyProbe {
      probe(@Body() body: unknown): unknown {
        return body;
      }
    }

    const bodyParamPrefix = (): string => {
      const meta = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        BodyProbe,
        'probe',
      ) as Record<string, unknown> | undefined;
      // Typed as `string`, but genuinely undefined if the metadata ever moves -
      // which is the failure this probe exists to make loud.
      const key = Object.keys(meta ?? {})[0];
      expect(key).toBeDefined();
      return `${key.split(':')[0]}:`;
    };

    const MUTATING = new Set([
      RequestMethod.POST,
      RequestMethod.PUT,
      RequestMethod.PATCH,
      RequestMethod.DELETE,
    ]);

    interface Route {
      name: string;
      declaresBody: boolean;
      marked: boolean;
    }

    const mutatingRoutes = (): Route[] => {
      const prefix = bodyParamPrefix();
      const routes: Route[] = [];

      for (const wrapper of discovery.getControllers()) {
        const controller = wrapper.metatype;
        if (!controller) continue;
        const basePath = Reflect.getMetadata(PATH_METADATA, controller) as
          | string
          | undefined;

        for (const key of Object.getOwnPropertyNames(controller.prototype)) {
          if (key === 'constructor') continue;
          const handler = (
            controller.prototype as Record<string, unknown> &
              Record<string, () => unknown>
          )[key];
          if (typeof handler !== 'function') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as
            | RequestMethod
            | undefined;
          if (method === undefined || !MUTATING.has(method)) continue;

          const args = (Reflect.getMetadata(
            ROUTE_ARGS_METADATA,
            controller,
            key,
          ) ?? {}) as Record<string, unknown>;
          const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) ??
            []) as unknown[];

          routes.push({
            name: `${controller.name}.${key} (${basePath ?? ''})`,
            declaresBody: Object.keys(args).some((k) => k.startsWith(prefix)),
            marked: guards.includes(NoBodyGuard),
          });
        }
      }
      return routes;
    };

    it('finds the routes at all (a walk that matches nothing proves nothing)', () => {
      const routes = mutatingRoutes();
      // ~30 at the time of writing; the floor guards against the reflection
      // silently returning an empty set after a Nest upgrade or a refactor.
      expect(routes.length).toBeGreaterThanOrEqual(25);
      expect(routes.some((r) => r.declaresBody)).toBe(true);
      expect(routes.some((r) => r.marked)).toBe(true);
    });

    it('every one either declares a @Body or carries @NoBody()', () => {
      const undeclared = mutatingRoutes()
        .filter((r) => !r.declaresBody && !r.marked)
        .map((r) => r.name);

      // A route in this list silently ignores whatever a caller sends it. Add
      // `@NoBody()` if it takes no arguments, or a strict `@Body` schema if it does.
      expect(undeclared).toEqual([]);
    });

    it('no route both declares a @Body and marks itself body-less', () => {
      // Contradictory: the marker would reject every body its own schema accepts.
      const both = mutatingRoutes()
        .filter((r) => r.declaresBody && r.marked)
        .map((r) => r.name);

      expect(both).toEqual([]);
    });
  });
});
