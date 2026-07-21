import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  ChannelsController,
  UnitChannelsController,
} from './channels.controller';
import { ChannelsRepository } from './channels.repository';
import { ChannelsService } from './channels.service';
import { HttpIcalFetcher, ICAL_FETCHER } from './ical-fetcher';
import { IcalExportService } from './ical-export.service';
import { IcalImportService } from './ical-import.service';
import { IcalImportSweeperService } from './ical-import-sweeper.service';
import { PublicChannelsController } from './public-channels.controller';
import { SyncConflictsController } from './sync-conflicts.controller';
import { SyncConflictsRepository } from './sync-conflicts.repository';
import { SyncConflictsService } from './sync-conflicts.service';

/**
 * channel-sync (architecture §3). #55 landed the connection lifecycle (connect /
 * list / disconnect) + the public `.ics` EXPORT feed; #56 (boss fight #3) added the
 * iCal IMPORT pipeline - the 30-min cron (IcalImportSweeperService) + the
 * per-VEVENT reconciliation core (IcalImportService) that "Sync now" also drives.
 * #38 completes it with the sync-conflict INBOX: the importer's per-VEVENT catch
 * now files a `sync_conflict` row when the exclusion constraint refuses an event
 * (a real-world double-sell), and SyncConflicts{Controller,Service,Repository} is
 * the owner's surface for reading and dismissing them (ADR-0027).
 *
 * The outbound iCal boundary (api-spec §8.5): ICAL_FETCHER is bound to
 * HttpIcalFetcher in prod/dev; tests `.overrideProvider(ICAL_FETCHER)` with a
 * fake, so no suite hits the network - the same port pattern as PAYMENT_GATEWAY
 * (ADR-0015). The fake is deliberately NOT in this DI graph.
 *
 * AuthModule provides JwtAuthGuard for the owner controllers; DbModule
 * (TenantDbService) and CommonModule (PublicScope, TenantContext) are @Global.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    UnitChannelsController,
    ChannelsController,
    PublicChannelsController,
    SyncConflictsController,
  ],
  providers: [
    ChannelsService,
    ChannelsRepository,
    SyncConflictsService,
    SyncConflictsRepository,
    IcalExportService,
    IcalImportService,
    IcalImportSweeperService,
    { provide: ICAL_FETCHER, useClass: HttpIcalFetcher },
  ],
})
export class ChannelSyncModule {}
