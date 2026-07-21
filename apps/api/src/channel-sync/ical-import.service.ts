import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import {
  booking,
  channelConnection,
  pgError,
  property,
  syncConflict,
  unit,
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
  /** VEVENTs this pull could not land because they overlap an existing occupying
   * booking - a real-world double-sell, recorded in the `sync_conflict` inbox for
   * the owner to resolve (#38). Not an error: the feed was healthy and the rest of
   * it imported. */
  conflicts: number;
}

/** The constraint whose refusal MEANS "the outside world double-sold these nights".
 * Keyed on the constraint NAME, not bare SQLSTATE 23P01, for ADR-0012's reason: the
 * DB names the domain fact, and a future exclusion constraint on some other table
 * must not silently start filing sync conflicts. */
const OVERLAP_CONSTRAINT = 'booking_no_overlap';

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

    // (2) Parse, in the PROPERTY's local clock (#145, ADR-0028) - a UTC-stamped
    //     VEVENT names no calendar date without one. Resolved HERE, once, rather
    //     than threaded in from the cron and "Sync now" separately: two callers
    //     each looking up the same fact is exactly the drift that gives a read a
    //     chance to disagree with a write.
    const timeZone = await this.resolveTimeZone(conn);
    if (timeZone === null) {
      // The connection outlived its unit/property. Its own FK cascade makes this
      // unreachable; if it ever happens, refusing to guess a zone is the safe end.
      return this.markError(conn, 'Unit or property no longer exists');
    }

    // A truncated/non-calendar body is UNHEALTHY: mark error, write nothing
    // (guarantee #3 - never reconcile a doubtful feed).
    const parsed = parseCalendar(fetched.body, timeZone);
    if (!parsed.ok) {
      return this.markError(conn, parsed.error);
    }

    // A feed naming a zone that is not this property's keeps its date part
    // verbatim (toIsoDate), which is right only while the two agree. No OTA we
    // support emits TZID at all, so this is silent in normal operation and speaks
    // ONLY when that assumption has broken - the tripwire #145 asked for.
    if (parsed.foreignTimeZones.length > 0) {
      this.logger.warn(
        `Feed for connection ${conn.id} names time zone(s) ` +
          `${parsed.foreignTimeZones.join(', ')} but its property is ${timeZone}; ` +
          `dates were taken verbatim and may be off by a day (#145)`,
      );
    }

    // (3) Healthy: reconcile in one transaction.
    const now = new Date();
    let imported = 0;
    let cancelled = 0;
    let conflicts = 0;
    // Every UID the feed offered that did NOT land, for ANY reason - an overlap we
    // filed, or a fault we only logged. This is the set closeHealed must protect,
    // and it is deliberately WIDER than "what conflicted": a UID that failed for an
    // unrelated reason has not been measured as healed either (see closeHealed).
    const notImportedUids: string[] = [];

    await this.dbs.db.transaction(async (tx) => {
      for (const event of parsed.events) {
        try {
          // A nested transaction is a SAVEPOINT (drizzle/pg): a per-event failure
          // rolls back only this event, leaving the outer txn usable.
          await tx.transaction((sp) => this.upsertEvent(sp, conn, event));
          imported++;
        } catch (err) {
          notImportedUids.push(event.uid);
          const { code, constraint } = pgError(err) ?? {};
          if (constraint === OVERLAP_CONSTRAINT) {
            // A real-world double-sell: the OTA sold nights we already hold. File
            // it in the inbox for a human to resolve and keep going (#38). NOTE the
            // INSERT goes to `tx`, the OUTER transaction - the savepoint that just
            // rolled back would have taken the record of itself with it.
            await this.recordConflict(tx, conn, event, now);
            conflicts++;
          } else {
            // Any other per-event fault is a DEFECT, not an operational conflict -
            // it stays in the log rather than in an owner's inbox, which exists for
            // things a human can actually go and fix in the real world.
            this.logger.warn(
              `Skipping VEVENT ${event.uid} on connection ${conn.id}` +
                `${code ? ` (${code})` : ''}: ${String(err)}`,
            );
          }
        }
      }

      cancelled = await this.cancelAbsent(tx, conn, parsed.events);
      await this.closeHealed(tx, conn, parsed.events, notImportedUids, now);

      await tx
        .update(channelConnection)
        .set({ lastStatus: 'ok', lastSyncedAt: now, lastError: null })
        // PK id alone would suffice (globally unique), but scope by tenant_id too
        // so EVERY write on this RLS-bypassed connection is literally tenant-scoped.
        .where(
          and(
            eq(channelConnection.id, conn.id),
            eq(channelConnection.tenantId, conn.tenantId),
          ),
        );
    });

    if (imported > 0 || cancelled > 0 || conflicts > 0) {
      this.logger.log(
        `Synced connection ${conn.id}: ${imported} reconciled, ${cancelled} cancelled` +
          `, ${conflicts} conflicted`,
      );
    }
    return {
      status: 'ok',
      lastSyncedAt: now,
      lastError: null,
      imported,
      cancelled,
      conflicts,
    };
  }

  /**
   * The property's local clock for this connection (#145, ADR-0028), via
   * `channel_connection -> unit -> property`. Null only if the unit or property
   * is gone.
   *
   * BOTH sides of the join are scoped by `tenant_id`, not just the unit. The
   * composite FK `unit_property_tenant_fk` already makes a cross-tenant pair
   * unrepresentable, so the property predicate is redundant today - but on this
   * RLS-bypassed connection the explicit WHERE is the load-bearing layer, not a
   * backstop, and "redundant because of a constraint elsewhere" is exactly the
   * reasoning that rots. Every statement here is literally tenant-scoped.
   */
  private async resolveTimeZone(
    conn: ChannelConnection,
  ): Promise<string | null> {
    const [row] = await this.dbs.db
      .select({ timeZone: property.timeZone })
      .from(unit)
      .innerJoin(property, eq(unit.propertyId, property.id))
      .where(
        and(
          eq(unit.id, conn.unitId),
          eq(unit.tenantId, conn.tenantId),
          eq(property.tenantId, conn.tenantId),
        ),
      )
      .limit(1);
    return row?.timeZone ?? null;
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
   * File one refused VEVENT in the conflict inbox (#38, ADR-0027) - the seam
   * ADR-0025 built this catch for. Idempotent by `(channel_connection_id,
   * external_uid)`: re-polling a feed that still double-sells UPDATEs the one row
   * rather than growing the inbox every 30 minutes (AC #2).
   *
   * The status rule on re-detection is the subtle part, and it is asymmetric on
   * purpose (ADR-0027):
   *   - `open`      → stays open. Only `last_seen_at` and the stay move.
   *   - `dismissed` → STAYS dismissed. The owner judged this UID a non-issue; if
   *     re-detection reopened it, every cron tick would undo that judgement and the
   *     inbox would become noise the owner learns to ignore.
   *   - `resolved`  → reopens. `resolved` is a measurement ("the constraint no
   *     longer refuses this"), and this pull just measured the opposite - the nights
   *     were freed and then re-taken, which is genuinely new information.
   *
   * Runs in its OWN savepoint: this is the code that exists so one bad VEVENT can't
   * sink a cycle, so it must not become the thing that sinks one. If filing the
   * conflict somehow fails, the outer transaction survives and the sync completes.
   *
   * The Drizzle lives here rather than in SyncConflictsRepository - which looks like a
   * layering break (controller → service → repository) but isn't a choice: that
   * repository runs on TenantDbService (the authed owner's RLS connection), while
   * this runs on DbService (RLS-bypassed, no principal) and must join the caller's
   * open transaction to stay inside the savepoint. They are different connections,
   * so they cannot share one repository. Same shape as upsertEvent/cancelAbsent (#56).
   */
  private async recordConflict(
    tx: DbTx,
    conn: ChannelConnection,
    event: ImportedEvent,
    now: Date,
  ): Promise<void> {
    try {
      await tx.transaction(async (sp) => {
        await sp
          .insert(syncConflict)
          .values({
            tenantId: conn.tenantId,
            channelConnectionId: conn.id,
            unitId: conn.unitId,
            externalUid: event.uid,
            checkIn: event.start,
            checkOut: event.end,
            status: 'open',
            firstDetectedAt: now,
            lastSeenAt: now,
          })
          .onConflictDoUpdate({
            target: [
              syncConflict.channelConnectionId,
              syncConflict.externalUid,
            ],
            set: {
              // The stay can move: an OTA may shift the double-sold dates between
              // polls, and the inbox must describe the CURRENT clash.
              checkIn: event.start,
              checkOut: event.end,
              lastSeenAt: now,
              // `first_detected_at` is deliberately absent - "since when" is the
              // one fact a re-detection must not overwrite.
              status: sql`case when ${syncConflict.status} = 'resolved'
                            then 'open'::sync_conflict_status
                            else ${syncConflict.status} end`,
              closedAt: sql`case when ${syncConflict.status} = 'resolved'
                              then null else ${syncConflict.closedAt} end`,
            },
          });
      });
    } catch (err) {
      this.logger.error(
        `Failed to record sync conflict for VEVENT ${event.uid} on connection ` +
          `${conn.id}: ${String(err)}`,
      );
    }
  }

  /**
   * Close every open conflict the world has since fixed - in one statement, because
   * "fixed" resolves to a single set. `resolved` is a MEASUREMENT (ADR-0027), so it
   * may only be written where this pull actually measured the clash gone. There are
   * exactly two such observations:
   *   - the blocking booking was cancelled → the UID's upsert SUCCEEDED this cycle
   *   - the OTA withdrew its double-sold event → the UID is absent from the feed
   *
   * Both are the complement of `notImportedUids` - every UID the feed offered that
   * did not land. That set is deliberately wider than "what overlapped": a VEVENT
   * that failed for an unrelated reason (a deadlock, a transient fault, a defect)
   * was NOT measured as healed either, and stamping its conflict `resolved` would
   * silently drop a live double-sell out of the inbox. Narrowing this to overlaps
   * alone was a real bug, caught in review - the invariant to hold onto is that
   * closing requires a POSITIVE observation, and a failure of any kind is not one.
   *
   * Guarded by `events.length >= 1`, the SAME rule as cancelAbsent and for the same
   * reason: on a healthy-but-empty feed every UID looks absent, and mass-closing an
   * owner's inbox on the strength of a feed that may have been truncated to zero is
   * the same mistake as mass-cancelling their bookings.
   *
   * `dismissed` rows are untouched (the WHERE is `status = 'open'`): a judgement is
   * not something a measurement gets to un-make.
   */
  private async closeHealed(
    tx: DbTx,
    conn: ChannelConnection,
    events: ImportedEvent[],
    notImportedUids: string[],
    now: Date,
  ): Promise<void> {
    if (events.length === 0) return;
    await tx
      .update(syncConflict)
      .set({ status: 'resolved', closedAt: now })
      .where(
        and(
          eq(syncConflict.channelConnectionId, conn.id),
          eq(syncConflict.tenantId, conn.tenantId),
          eq(syncConflict.status, 'open'),
          // notInArray with an empty list is a no-op filter in drizzle, which is
          // exactly right here: every offered UID landed, so every open row healed.
          notImportedUids.length > 0
            ? notInArray(syncConflict.externalUid, notImportedUids)
            : undefined,
        ),
      );
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
      .where(
        and(
          eq(channelConnection.id, conn.id),
          eq(channelConnection.tenantId, conn.tenantId),
        ),
      );
    this.logger.warn(`Connection ${conn.id} unhealthy: ${error}`);
    return {
      status: 'error',
      lastSyncedAt: conn.lastSyncedAt,
      lastError: error,
      imported: 0,
      cancelled: 0,
      conflicts: 0,
    };
  }
}
