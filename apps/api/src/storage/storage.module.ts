import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhotoGcSweeperService } from './photo-gc-sweeper.service';
import { StorageService } from './storage.service';

// PhotoGcSweeperService is the orphaned-photo GC cron (#69, ADR-0017). It lives
// here, beside StorageService whose list/delete it drives, and reads `property`
// directly via the global DbService (owner connection) - the same cross-tenant
// shape as the M2 hold sweeper. @nestjs/schedule discovers its @Cron at runtime;
// it stays injectable so tests drive sweep(now) directly (ScheduleModule is
// skipped under NODE_ENV=test, so no tick lands mid-suite).
@Module({
  providers: [StorageService, PhotoGcSweeperService],
  exports: [StorageService],
})
export class StorageModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageModule.name);

  constructor(
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  // Dev convenience: make a fresh `docker compose up` bucket usable without
  // manual steps. Failure is a warning, not a crash - the API stays usable
  // (photo uploads simply won't work until Garage is up).
  //
  // No origin is passed: the dev CORS policy is a constant, so concurrent boots
  // against the one shared Garage cannot overwrite each other's answer (#182 -
  // see applyDevBucketConfig for the measurement behind that).
  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('STORAGE_BOOTSTRAP') !== 'true') return;
    try {
      await this.storage.applyDevBucketConfig();
      this.logger.log(
        'Bucket CORS + website access applied (browser PUT from any dev origin)',
      );
    } catch (err) {
      this.logger.warn(
        `Storage bootstrap failed - is Garage up (docker compose up -d)? ` +
          `Photo uploads will not work until it is. ${String(err)}`,
      );
    }
  }
}
