import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

@Module({
  providers: [StorageService],
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
  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('STORAGE_BOOTSTRAP') !== 'true') return;
    const origin =
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:5173';
    try {
      await this.storage.applyDevBucketConfig(origin);
      this.logger.log(
        `Bucket CORS + website access applied (PUT from ${origin})`,
      );
    } catch (err) {
      this.logger.warn(
        `Storage bootstrap failed - is Garage up (docker compose up -d)? ` +
          `Photo uploads will not work until it is. ${String(err)}`,
      );
    }
  }
}
