import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { sql } from 'drizzle-orm';
import { createDb, type DbTx } from '@sambung/db';
import type { TenantPrincipal } from '../common/tenant-context.service';

// Tenant-scoped database access (boss fight #5, app layer). Every callback
// runs inside a transaction on the NON-OWNER app role that first sets
// `app.tenant_id` via parameterized set_config (no SQL injection). Combined
// with the RLS policies, the database itself scopes every query to the current
// tenant. No tenant in context (a system path) → the GUC stays unset; RLS is
// fail-closed, so those queries return nothing.
@Injectable()
export class TenantDbService implements OnModuleDestroy {
  private readonly conn: ReturnType<typeof createDb>;

  constructor(
    config: ConfigService,
    private readonly cls: ClsService,
  ) {
    this.conn = createDb(config.getOrThrow<string>('APP_DATABASE_URL'));
  }

  /** Run tenant-scoped queries - use this for all tenant-owned reads/writes. */
  run<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    const tenantId = this.cls.get<TenantPrincipal>('principal')?.tenantId;
    return this.conn.db.transaction(async (tx) => {
      if (tenantId) {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
      }
      return fn(tx);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.conn.close();
  }
}
