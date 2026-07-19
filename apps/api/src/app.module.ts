import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { DbErrorInterceptor } from './common/db-error/db-error.interceptor';
import { EnvelopeThrottlerGuard } from './common/throttle/envelope-throttler.guard';
import { THROTTLE_SENSITIVE } from './common/throttle/throttle.decorator';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { ChannelSyncModule } from './channel-sync/channel-sync.module';
import { PaymentsModule } from './payments/payments.module';
import { PropertiesModule } from './properties/properties.module';
import { UnitsModule } from './units/units.module';

@Module({
  imports: [
    // Loads apps/api/.env (via dotenv) into ConfigService for every context,
    // tests included - DbService / TenantDbService read DATABASE_URL /
    // APP_DATABASE_URL through ConfigService.getOrThrow, which names the cause
    // if a var is missing. This is the ONLY thing tests rely on for env; there
    // is no separate jest setup shim (a former `test-setup.ts` called
    // process.loadEnvFile(), which silently no-ops under jest's sandboxed
    // process.env - deleted in #81).
    ConfigModule.forRoot({ isGlobal: true }),
    // Opens an AsyncLocalStorage store per request (mounted as middleware) so
    // the guard can seed TenantContext and services can read it ambiently.
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    // Cron discovery for the hold-expiry sweeper (boss fight #1, #48). One VPS =
    // one process, so the @Cron fires exactly once per tick - no distributed lock
    // needed, and the sweep is idempotent besides (ADR-0009). Skipped under test:
    // the sweeper service stays injectable and is driven directly, so a 5-minute
    // tick can't land mid-suite and sweep a test's holds out from under it.
    ...(process.env.NODE_ENV === 'test' ? [] : [ScheduleModule.forRoot()]),
    // Rate limit the public surface - the booking write is a no-auth write, so a
    // naked endpoint invites calendar-griefing and row-flooding (#48, Q9). Global
    // guard (below) covers every route at once; in-memory storage (default) fits
    // a single VPS with no Redis. Limits are env-driven with a PROTECTIVE default
    // so an unconfigured prod is still guarded; dev/test set them high.
    //
    // TWO tiers (api-spec §8.3, #59): a GENEROUS `default` on every route, and a
    // TIGHTER `sensitive` on the abuse-prone few (auth login/register, the no-auth
    // public booking). A route opts into `sensitive` with `@ThrottleSensitive()`;
    // the `skipIf` below skips it everywhere the marker is absent, so a legit owner
    // browsing the dashboard never trips the tight limit. Each throttler keeps its
    // own per-handler bucket, so a burst of logins can't exhaust a guest's booking
    // allowance and vice-versa.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, Reflector],
      useFactory: (config: ConfigService, reflector: Reflector) => ({
        throttlers: [
          {
            name: 'default',
            ttl: Number(config.get('THROTTLE_TTL_MS') ?? 60_000),
            limit: Number(config.get('THROTTLE_LIMIT') ?? 60),
          },
          {
            name: 'sensitive',
            ttl: Number(config.get('THROTTLE_SENSITIVE_TTL_MS') ?? 60_000),
            limit: Number(config.get('THROTTLE_SENSITIVE_LIMIT') ?? 10),
            // Applies ONLY to routes carrying @ThrottleSensitive(); skipped (and so
            // a no-op) on the rest of the API and on non-HTTP contexts.
            skipIf: (ctx) =>
              ctx.getType() !== 'http' ||
              !reflector.getAllAndOverride<boolean>(THROTTLE_SENSITIVE, [
                ctx.getHandler(),
                ctx.getClass(),
              ]),
          },
        ],
      }),
    }),
    CommonModule,
    DbModule,
    AuthModule,
    PropertiesModule,
    UnitsModule,
    BookingsModule,
    PaymentsModule,
    ChannelSyncModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global on purpose: a constraint violation means the same thing on every
    // route, and a per-module opt-in is a per-module chance to forget. Services
    // that want to handle their own violation just catch it first.
    { provide: APP_INTERCEPTOR, useClass: DbErrorInterceptor },
    // Global rate-limit guard (configured by ThrottlerModule above). The Envelope
    // subclass renders the 429 in the app's error envelope (#59); everything else
    // is the stock guard.
    { provide: APP_GUARD, useClass: EnvelopeThrottlerGuard },
  ],
})
export class AppModule {}
