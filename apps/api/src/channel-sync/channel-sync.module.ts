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
import { PublicChannelsController } from './public-channels.controller';

/**
 * channel-sync (architecture §3). This issue (#55) lands the connection lifecycle
 * (connect / list / disconnect) + the public `.ics` EXPORT feed; the iCal IMPORT
 * pipeline (the cron, per-VEVENT reconciliation, the sync-conflict inbox) is boss
 * fight #3, a separate M4 issue that joins this module.
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
  ],
  providers: [
    ChannelsService,
    ChannelsRepository,
    IcalExportService,
    { provide: ICAL_FETCHER, useClass: HttpIcalFetcher },
  ],
})
export class ChannelSyncModule {}
