import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, sql } from 'drizzle-orm';
import { booking } from '@sambung/db';
import { DbService } from '../db/db.service';
import { HOLD_SWEEP_CRON } from './booking.constants';

/**
 * The cross-tenant hold-expiry sweeper - the cron backstop of the two-scope
 * design (ADR-0009, boss fight #1). The exclusion constraint can't reference
 * `now()` (immutable predicate), so a lapsed hold keeps occupying until its
 * status is flipped; the service's opportunistic sweep does that for a unit
 * being actively booked, and this catches every OTHER lapsed hold - the ones on
 * units nobody is touching.
 *
 * It runs on the OWNER connection (DbService), which bypasses RLS, precisely
 * because it crosses tenants: one UPDATE sweeps every tenant's lapsed holds. That
 * is why it can't be a tenant-scoped query - there is no single tenant to scope
 * to (the mirror of why the opportunistic sweep, being intra-tenant, can).
 *
 * Single VPS = one process = the @Cron fires once per tick, so no distributed
 * lock is needed. And it's idempotent regardless: the WHERE matches only holds
 * already past their TTL, so a second run - or the opportunistic sweep racing it
 * - flips nothing (they serialize on the row lock, the loser updates zero rows).
 */
@Injectable()
export class HoldSweeperService {
  private readonly logger = new Logger(HoldSweeperService.name);

  constructor(private readonly dbs: DbService) {}

  @Cron(HOLD_SWEEP_CRON)
  async sweepExpiredHolds(): Promise<number> {
    const swept = await this.dbs.db
      .update(booking)
      .set({ status: 'expired' })
      .where(
        and(
          eq(booking.status, 'pending_payment'),
          sql`${booking.holdExpiresAt} < now()`,
        ),
      )
      .returning({ id: booking.id });

    if (swept.length > 0) {
      this.logger.log(`Swept ${swept.length} expired hold(s) to 'expired'`);
    }
    return swept.length;
  }
}
