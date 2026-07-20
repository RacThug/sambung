import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  channelConnectionResponseSchema,
  syncConnectionResponseSchema,
  type ChannelConnectionResponse,
  type CreateChannelConnectionRequest,
  type DisconnectChannelResponse,
  type SyncConnectionResponse,
} from '@sambung/shared';
import type { ChannelConnection } from '@sambung/db';
import { channelAlreadyConnected } from '../common/db-error/conflicts';
import { TenantDbService } from '../db/tenant-db.service';
import { ChannelsRepository } from './channels.repository';
import { ICAL_FETCHER, type IcalFetcher } from './ical-fetcher';
import { IcalImportService } from './ical-import.service';

/**
 * The channel-connection lifecycle (api-spec §7.1/7.2/7.4, #55) - the OWNER side
 * of sync. Connect an OTA iCal URL to a Unit (validated at the boundary +
 * smoke-fetched here), list connections with their health, disconnect.
 *
 * The IMPORT pipeline (the 30-min cron, per-VEVENT reconciliation, the
 * sync-conflict inbox) is boss fight #3, a separate M4 issue - this issue is the
 * lifecycle plus the EXPORT feed (IcalExportService).
 */
@Injectable()
export class ChannelsService {
  constructor(
    private readonly repo: ChannelsRepository,
    private readonly db: TenantDbService,
    @Inject(ICAL_FETCHER) private readonly fetcher: IcalFetcher,
    private readonly importer: IcalImportService,
  ) {}

  /**
   * Connect a channel (api-spec §7.1). The URL is validated as https at the
   * boundary (zod); here it is smoke-fetched once so `lastStatus` reflects
   * reality immediately (FR-SYNC-3) - a feed that's down connects anyway, with
   * `error` status, so the owner sees the problem instead of a silent future
   * import failure.
   *
   * Order matters: verify the unit (404), pre-check the duplicate (a friendly 409
   * with no wasted network call), THEN fetch and insert. The insert's unique
   * constraint backstops a race between the pre-check and it, mapped to the same
   * 409 (§5.3). The fetch is deliberately NOT inside a transaction - it's a
   * network round-trip, and holding a pooled connection open across it would
   * starve the pool.
   */
  async connect(
    unitId: string,
    dto: CreateChannelConnectionRequest,
  ): Promise<ChannelConnectionResponse> {
    if (!(await this.repo.unitExists(unitId))) {
      throw new NotFoundException('Unit not found');
    }
    if (await this.repo.findByUnitAndChannel(unitId, dto.channel)) {
      throw channelAlreadyConnected();
    }

    const probe = await this.fetcher.probe(dto.importIcalUrl);
    const row = await this.repo.create({
      unitId,
      channel: dto.channel,
      importIcalUrl: dto.importIcalUrl,
      lastStatus: probe.ok ? 'ok' : 'error',
      lastError: probe.error,
      // Only a healthy pull stamps a sync time; a failed probe never "synced".
      lastSyncedAt: probe.ok ? new Date() : null,
    });
    return this.toResponse(row);
  }

  /** List a unit's connections (api-spec §7.2). 404 for an unknown/foreign unit. */
  async list(unitId: string): Promise<ChannelConnectionResponse[]> {
    if (!(await this.repo.unitExists(unitId))) {
      throw new NotFoundException('Unit not found');
    }
    const rows = await this.repo.findByUnit(unitId);
    return rows.map((row) => this.toResponse(row));
  }

  /**
   * Disconnect (api-spec §7.4). KEEPS every imported booking - the API never
   * auto-cancels a confirmed booking (ADR 2026-07-16) - and reports how many
   * remain so the owner can clean up deliberately. One transaction so the count is
   * the pre-delete state (the `booking.channel_connection_id` FK is `set null`, so
   * counting after the delete would read zero).
   */
  async disconnect(id: string): Promise<DisconnectChannelResponse> {
    return this.db.run(async () => {
      const found = await this.repo.findById(id);
      if (!found) {
        throw new NotFoundException('Channel connection not found');
      }
      const importedBookingsKept = await this.repo.countImportedBookings(id);
      await this.repo.delete(id);
      return { importedBookingsKept };
    });
  }

  /**
   * "Sync now" (api-spec §7.3): force one connection's import off the 30-min cron,
   * immediately. Two-step by design: resolve the connection under the owner's RLS
   * scope FIRST (an unknown / foreign id is a 404, never a 403 - existence is
   * hidden, §1), THEN hand the resolved row to the importer, which reconciles on
   * the owner connection (the same cross-tenant path the cron uses). Runs
   * synchronously and returns the connection's post-sync health + a summary of
   * what this pull did - there is no job queue on a single VPS (ADR-0025), so the
   * honest contract is the result, not a `{ queued: true }` promise.
   */
  async syncNow(id: string): Promise<SyncConnectionResponse> {
    const conn = await this.repo.findById(id);
    if (!conn) {
      throw new NotFoundException('Channel connection not found');
    }
    const outcome = await this.importer.syncConnection(conn);
    return syncConnectionResponseSchema.parse({
      lastStatus: outcome.status,
      lastSyncedAt: outcome.lastSyncedAt
        ? outcome.lastSyncedAt.toISOString()
        : null,
      lastError: outcome.lastError,
      imported: outcome.imported,
      cancelled: outcome.cancelled,
    });
  }

  private toResponse(row: ChannelConnection): ChannelConnectionResponse {
    const { createdAt, lastSyncedAt, ...columns } = row;
    // Parsed on the way out so the payload cannot silently widen, and so a corrupt
    // `channel` / `last_status` in the DB fails loud rather than reaching a client.
    return channelConnectionResponseSchema.parse({
      ...columns,
      lastSyncedAt: lastSyncedAt ? lastSyncedAt.toISOString() : null,
      createdAt: createdAt.toISOString(),
    });
  }
}
