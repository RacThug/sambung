import { Injectable, NotFoundException } from '@nestjs/common';
import {
  dismissSyncConflictResponseSchema,
  syncConflictSchema,
  type DismissSyncConflictResponse,
  type ListSyncConflictsQuery,
  type SyncConflict,
} from '@sambung/shared';
import {
  SyncConflictsRepository,
  type BlockingBookingRow,
  type SyncConflictRow,
} from './sync-conflicts.repository';

/**
 * The sync-conflict inbox (#38, boss fight #3, ADR-0027, api-spec §7.5) - the owner's
 * surface for a real-world double-sell: an OTA sold nights Sambung already holds, so
 * the `booking_no_overlap` exclusion constraint refused the import and the pipeline
 * filed it here instead of crashing (ADR-0025).
 *
 * Thin, like the paid-but-lapsed inbox it mirrors (ADR-0022): it shapes rows for the
 * wire and maps the dismiss outcome to HTTP. Tenant scoping lives in the repository
 * (RLS + an explicit `tenant_id`), so there is no ownership check to run here - every
 * row this service can reach already belongs to the caller.
 *
 * There is deliberately no `resolve` method - see the contract in
 * `packages/shared/src/sync-conflict.ts` for why, and ADR-0027 for the full argument.
 */
@Injectable()
export class SyncConflictsService {
  constructor(private readonly repo: SyncConflictsRepository) {}

  /** AC: the conflict list. Two queries, never N+1 - the rows, then every blocking
   * booking for all of them at once, regrouped in memory. */
  async list(query: ListSyncConflictsQuery): Promise<SyncConflict[]> {
    const rows = await this.repo.list(query);
    if (rows.length === 0) return [];

    const blocking = await this.repo.findBlockingBookings(
      rows.map((r) => r.id),
    );
    const byConflict = new Map<string, BlockingBookingRow[]>();
    for (const row of blocking) {
      const bucket = byConflict.get(row.conflictId);
      if (bucket) bucket.push(row);
      else byConflict.set(row.conflictId, [row]);
    }

    return rows.map((row) => this.toWire(row, byConflict.get(row.id) ?? []));
  }

  /**
   * AC: dismiss one. Idempotent by design - dismissing an already-closed conflict
   * echoes its real state (200) rather than refusing, so a double-click or a stale
   * list needs no ADR-0012 conflict code. Only an id this tenant cannot see is an
   * error, and that is a 404 rather than a 403 (§1: existence is never disclosed).
   */
  async dismiss(id: string): Promise<DismissSyncConflictResponse> {
    const outcome = await this.repo.dismiss(id);
    if (outcome.kind === 'not_found') {
      throw new NotFoundException('No sync conflict with that id');
    }
    return dismissSyncConflictResponseSchema.parse({
      id,
      status: outcome.status,
      closedAt: outcome.closedAt ? outcome.closedAt.toISOString() : null,
    });
  }

  private toWire(
    row: SyncConflictRow,
    blocking: BlockingBookingRow[],
  ): SyncConflict {
    // Parsed on the way out so the payload cannot silently widen, and so a `channel`
    // or `source` the shared enums don't know fails loud here rather than reaching a
    // client that would render it as a blank chip.
    return syncConflictSchema.parse({
      id: row.id,
      propertyId: row.propertyId,
      propertyName: row.propertyName,
      unitId: row.unitId,
      unitName: row.unitName,
      channel: row.channel,
      externalUid: row.externalUid,
      // Half-open on the wire exactly as in the DB: `to` is the check-out date, not
      // a night (invariant #4).
      stay: { from: row.checkIn, to: row.checkOut },
      status: row.status,
      firstDetectedAt: row.firstDetectedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      // `source` / `status` arrive as plain strings from the row type; the schema
      // above is what narrows them to the shared enums (and rejects an unknown one).
      blockingBookings: blocking.map((b) => ({
        id: b.id,
        source: b.source,
        status: b.status,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        guestName: b.guestName,
      })),
    });
  }
}
