import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDb, type Db } from '@sambung/db';

// The API's OWNER-connection gateway to the database (system ops: auth /
// registration, test fixtures). Bypasses RLS - tenant-scoped reads/writes
// belong on TenantDbService instead. apps/web never imports this (invariant #1).
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly conn: ReturnType<typeof createDb>;
  readonly db: Db;

  constructor(config: ConfigService) {
    this.conn = createDb(config.getOrThrow<string>('DATABASE_URL'));
    this.db = this.conn.db;
  }

  async onModuleDestroy(): Promise<void> {
    await this.conn.close();
  }
}
