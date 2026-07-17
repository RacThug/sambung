import {
  ConflictException,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { eq } from 'drizzle-orm';
import { appUser, booking, property, tenant, unit } from '@sambung/db';
import { AppModule } from '../../app.module';
import { DbService } from '../../db/db.service';
import { DbErrorInterceptor } from './db-error.interceptor';
import { mapDbError } from './db-error.map';

// The map and the interceptor (#80).
//
// auth.spec.ts:103 already proves the MAPPED path end-to-end: a concurrent
// duplicate signup must 409, never 500 (bcrypt's ~300ms window is what makes
// both requests clear the pre-check and race at the constraint). These cover
// what that test cannot - what happens to violations nobody mapped, which is
// the map's entire safety claim.
//
// Every error here is real, caught from a real violation, because the shape
// drizzle throws IS the thing under test: it wraps the pg error, so the
// top-level message is only "Failed query: ..." and pgError has to walk the
// cause chain to find the constraint name. A hand-built fixture would test our
// idea of that shape rather than the shape.
describe('DbError mapping', () => {
  let app: INestApplication;
  let dbs: DbService;
  let tenantId: string;
  let unitId: string;

  /** Run something that violates a constraint; hand back what was thrown. */
  const violate = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn();
    } catch (e) {
      return e;
    }
    throw new Error('expected a constraint violation, got none');
  };

  /** A real 23505 on app_user_email_key - the one constraint that is mapped. */
  const duplicateEmail = () =>
    violate(() =>
      dbs.db.insert(appUser).values({
        tenantId,
        email: 'dberror@test.dev',
        passwordHash: 'x',
        role: 'owner',
      }),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dbs = app.get(DbService);

    const [t] = await dbs.db
      .insert(tenant)
      .values({ name: 'DbError Map Test' })
      .returning({ id: tenant.id });
    tenantId = t.id;
    await dbs.db.insert(appUser).values({
      tenantId,
      email: 'dberror@test.dev',
      passwordHash: 'x',
      role: 'owner',
    });
    const [p] = await dbs.db
      .insert(property)
      .values({ tenantId, name: 'DbError Villa' })
      .returning({ id: property.id });
    const [u] = await dbs.db
      .insert(unit)
      .values({ tenantId, propertyId: p.id, name: 'U', basePriceIdr: 1n })
      .returning({ id: unit.id });
    unitId = u.id;
  });

  afterAll(async () => {
    await dbs.db.delete(tenant).where(eq(tenant.id, tenantId));
    await app.close();
  });

  describe('mapDbError', () => {
    it('maps a mapped constraint to the response it means', async () => {
      const mapped = mapDbError(await duplicateEmail());
      expect(mapped).toBeInstanceOf(ConflictException);
      expect(mapped?.getStatus()).toBe(409);
      expect(mapped?.getResponse()).toMatchObject({
        message: 'Email already registered',
      });
    });

    it('does NOT map a constraint we have no opinion about', async () => {
      // A real 23514 (booking_stay_nonempty: check_out must beat check_in).
      // Nothing maps it, because no booking module exists to say whether that
      // is a 400 or a 409. Until then it must reach a 500: a guessed status
      // would make a broken write look like a user error, and would be
      // indistinguishable from a considered decision.
      const err = await violate(() =>
        dbs.db.insert(booking).values({
          tenantId,
          unitId,
          source: 'direct',
          status: 'confirmed',
          checkIn: '2027-01-13',
          checkOut: '2027-01-10',
        }),
      );
      expect(mapDbError(err)).toBeUndefined();
    });

    it('does not map an error that did not come from the database', () => {
      expect(mapDbError(new Error('kaboom'))).toBeUndefined();
      expect(mapDbError('a string')).toBeUndefined();
      expect(mapDbError(undefined)).toBeUndefined();
    });
  });

  describe('DbErrorInterceptor', () => {
    const interceptor = new DbErrorInterceptor();
    const ctx = {} as ExecutionContext;
    const through = (err: unknown) =>
      firstValueFrom(
        interceptor.intercept(ctx, { handle: () => throwError(() => err) }),
      );

    it('rethrows a mapped violation as its HttpException', async () => {
      await expect(through(await duplicateEmail())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rethrows an unmapped error untouched, so it reaches a 500', async () => {
      const err = new Error('kaboom');
      // Same object, not wrapped: Nest's default handling must see exactly what
      // was thrown.
      await expect(through(err)).rejects.toBe(err);
    });

    it('leaves a successful response alone', async () => {
      const ok = { id: 1 };
      expect(
        await firstValueFrom(
          interceptor.intercept(ctx, { handle: () => of(ok) }),
        ),
      ).toBe(ok);
    });
  });
});
