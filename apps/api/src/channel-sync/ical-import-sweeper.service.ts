import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IMPORT_SWEEP_CRON } from './channel-sync.constants';
import { IcalImportService } from './ical-import.service';

/**
 * The 30-minute import cron (#56, FR-SYNC-1, architecture flow B). Thin: it owns
 * the SCHEDULE and re-entrancy; the reconciliation itself lives in
 * IcalImportService (which "Sync now" also drives, so the two share one code
 * path). The same shape as HoldSweeperService / PhotoGcSweeperService - a
 * cross-tenant @Cron on the owner connection.
 *
 * Single VPS = one process, so the @Cron fires once per tick - no distributed
 * lock. The in-instance `running` guard skips a tick if the previous sweep is
 * still in flight (many slow feeds could otherwise overlap the next tick); the
 * reconciliation is idempotent besides, so a skipped tick loses nothing.
 *
 * Not registered under test: AppModule omits ScheduleModule when NODE_ENV=test,
 * so this stays injectable and is driven directly - a 30-minute tick can't land
 * mid-suite and reconcile a test's fixtures out from under it (same as the hold
 * sweeper).
 */
@Injectable()
export class IcalImportSweeperService {
  private readonly logger = new Logger(IcalImportSweeperService.name);
  private running = false;

  constructor(private readonly importer: IcalImportService) {}

  @Cron(IMPORT_SWEEP_CRON)
  async sweep(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        'iCal import sweep skipped: previous run still in progress',
      );
      return;
    }
    this.running = true;
    try {
      await this.importer.syncAllConnections();
    } finally {
      this.running = false;
    }
  }
}
