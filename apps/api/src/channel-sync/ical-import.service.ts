import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import {
  booking,
  channelConnection,
  pgError,
  type BookingSource,
  type ChannelConnection,
  type DbTx,
} from '@sambung/db';
import type { SyncStatus } from '@sambung/shared';
import { DbService } from '../db/db.service';
import { ICAL_FETCHER, type IcalFetcher } from './ical-fetcher';
import { parseCalendar, type ImportedEvent } from './ical-parse';

/** What one connection's sync did - surfaced to "Sync now" (§7.3) and logged by
 * the cron. `lastSyncedAt` is `now` on a healthy pull, unchanged on an error (a
 * failed pull never "synced"). `imported` = feed events reconciled; `cancelled` =
 * OTA-side cancellations reflected. */
export interface SyncOutcome {
  status: SyncStatus; // 'ok' | 'error' (never 'never' after a real pull)
  lastSyncedAt: Date | null;
  lastError: string | null;
  imported: number;
  cancelled: number;
}

/**
 * The iCal IMPORT pipeline (#56, boss fight #3, architecture flow B). Pulls each
 * connection's OTA feed, upserts its VEVENTs into `booking` idempotently by
 * `external_uid`, and cancels bookings whose UID vanished from a HEALTHY feed -
 * the "channel manager" half of Sambung (FR-SYNC-1).
 *
 * It runs on the OWNER connection (DbService, RLS-bypassed), the same shape as the
 * hold sweeper (ADR-0009) and the payment webhook (ADR-0018), and for the same
 * reason: a system reconciliation with NO principal that crosses tenants has no
 * single tenant to scope to. Because RLS is off here, every write is scoped
 * EXPLICITLY by `tenant_id` (+ the connection id) - the second-layer WHERE every
 * repository keeps, load-bearing on this connection rather than a backstop.
 *
 * Three reliability guarantees make this a boss fight (ADR-0025):
 *  1. **Fetch OUTSIDE the transaction.** A network round-trip must never pin a
 *     pooled DB connection open (the connect endpoint's rule).
 *  2. **Savepoint per VEVENT.** A single event that overlaps an existing booking
 *     (23P01 - a real-world double-sell) rolls back only its savepoint; the cycle
 *     continues. That catch is exactly the seam the #38 conflict inbox slots into.
 *  3. **Never mass-cancel.** The absent-UID cancellation runs ONLY on a healthy
 *     feed with >= 1 event - a truncated/empty/errored pull changes nothing.
 */
@Injectable()
export class IcalImportService {
  private readonly logger = new Logger(IcalImportService.name);

  constructor(
    private readonly dbs: DbService,
    @Inject(ICAL_FETCHER) private readonly fetcher: IcalFetcher,
  ) {}

  /**
   * The cron entry: reconcile EVERY connection across all tenants (owner
   * connection). One feed's failure is isolated - a thrown sync never sinks the
   * tick, so a single broken OTA can't stop every other tenant from syncing.
   */
  async syncAllConnections(): Promise<void> {
    const connections = await this.dbs.db.select().from(channelConnection);
    for (const conn of connections) {
      try {
        await this.syncConnection(conn);
      } catch (err) {
        this.logger.error(
          `iCal sync crashed for connection ${conn.id}: ${String(err)}`,
        );
      }
    }
  }

  /**
   * Reconcile ONE connection. Fetch (outside any txn) → parse → if healthy, one
   * transaction: savepoint-per-VEVENT upserts, then the absent-UID cancellation,
   * then the status stamp - all commit together, or none do. An unhealthy pull
   * marks the connection `error` and changes nothing else.
   */
  async syncConnection(conn: ChannelConnection): Promise<SyncOutcome> {
    // (1) Pull the body OUTSIDE the transaction - never hold a pooled connection
    //     across a network round-trip.
    const fetched = await this.fetcher.fetchFeed(conn.importIcalUrl);
    if (!fetched.ok || fetched.body === null) {
      return this.markError(conn, fetched.error ?? 'Feed is unreachable');
    }

    // (2) Parse. A truncated/non-calendar body is UNHEALTHY: mark error, write
    //     nothing (guarantee #3 - never reconcile a doubtful feed).
    const parsed = parseCalendar(fetched.body);
    if (!parsed.ok) {
      return this.markError(conn, parsed.error);
    }

    // (3) Healthy: reconcile in one transaction.
    const now = new Date();
    let imported = 0;
    let cancelled = 0;

    await this.dbs.db.transaction(async (tx) => {
      for (const event of parsed.events) {
        try {
          // A nested transaction is a SAVEPOINT (drizzle/pg): a per-event failure
          // rolls back only this event, leaving the outer txn usable.
          await tx.transaction((sp) => this.upsertEvent(sp, conn, event));
          imported++;
        } catch (err) {
          // 23P01 = overlaps an existing occupying booking (a real double-sell),
          // or any other per-event fault. Skip it, keep the cycle alive. Recording
          // it in a `sync_conflict` inbox is #38 - this is where that INSERT lands
          // (db-design §4.8).
          const code = pgError(err)?.code;
          this.logger.warn(
            `Skipping VEVENT ${event.uid} on connection ${conn.id}` +
              `${code ? ` (${code})` : ''}: ${String(err)}`,
          );
        }
      }

      cancelled = await this.cancelAbsent(tx, conn, parsed.events);

      await tx
        .update(channelConnection)
        .set({ lastStatus: 'ok', lastSyncedAt: now, lastError: null })
        .where(eq(channelConnection.id, conn.id));
    });

    if (imported > 0 || cancelled > 0) {
      this.logger.log(
        `Synced connection ${conn.id}: ${imported} reconciled, ${cancelled} cancelled`,
      );
    }
    return {
      status: 'ok',
      lastSyncedAt: now,
      lastError: null,
      imported,
      cancelled,
    };
  }

  /**
   * Upsert one VEVENT as a confirmed booking, idempotent by
   * `(channel_connection_id, external_uid)` (the partial unique index): a re-pull
   * is a no-op UPDATE, a changed stay updates in place, and a previously
   * auto-cancelled UID that reappears is re-confirmed. `source = channel`, no
   * guest PII, no price - an availability block carries none.
   */
  private async upsertEvent(
    tx: DbTx,
    conn: ChannelConnection,
    event: ImportedEvent,
  ): Promise<void> {
    await tx
      .insert(booking)
      .values({
        tenantId: conn.tenantId,
        unitId: conn.unitId,
        // channel ∈ {airbnb, booking_com, vrbo} ⊂ booking_source (zod-closed at
        // connect), so the imported stay's source IS the channel it came from.
        source: conn.channel as BookingSource,
        status: 'confirmed',
        checkIn: event.start,
        checkOut: event.end,
        externalUid: event.uid,
        channelConnectionId: conn.id,
      })
      .onConflictDoUpdate({
        target: [booking.channelConnectionId, booking.externalUid],
        targetWhere: sql`${booking.externalUid} is not null`,
        set: { checkIn: event.start, checkOut: event.end, status: 'confirmed' },
      });
  }

  /**
   * Cancel bookings WE imported through this connection whose UID vanished from
   * the feed - an OTA-side cancellation (db-design §4.7). Scoped by
   * `channel_connection_id` + `tenant_id` + a non-null `external_uid`, so a direct
   * or manual booking is structurally untouchable: we only ever cancel our own
   * imports.
   *
   * Guarded by `events.length >= 1` (guarantee #3): a healthy-but-empty feed is
   * indistinguishable from a feed truncated to zero, so we refuse to mass-cancel.
   * A genuine full clear-out on the OTA is the owner's manual call (ADR-0025).
   */
  private async cancelAbsent(
    tx: DbTx,
    conn: ChannelConnection,
    events: ImportedEvent[],
  ): Promise<number> {
    if (events.length === 0) return 0;
    const presentUids = events.map((e) => e.uid);
    const cancelledRows = await tx
      .update(booking)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(booking.channelConnectionId, conn.id),
          eq(booking.tenantId, conn.tenantId),
          eq(booking.status, 'confirmed'),
          isNotNull(booking.externalUid),
          notInArray(booking.externalUid, presentUids),
        ),
      )
      .returning({ id: booking.id });
    return cancelledRows.length;
  }

  /** Mark a connection unhealthy: `last_status = error`, keep `last_synced_at`
   * (a failed pull never synced), write nothing else. Returns the outcome so
   * "Sync now" reports the failure honestly. */
  private async markError(
    conn: ChannelConnection,
    error: string,
  ): Promise<SyncOutcome> {
    await this.dbs.db
      .update(channelConnection)
      .set({ lastStatus: 'error', lastError: error })
      .where(eq(channelConnection.id, conn.id));
    this.logger.warn(`Connection ${conn.id} unhealthy: ${error}`);
    return {
      status: 'error',
      lastSyncedAt: conn.lastSyncedAt,
      lastError: error,
      imported: 0,
      cancelled: 0,
    };
  }
}
