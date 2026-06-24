import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { PrismaClient } from '@sambung/db';
import type { TenantPrincipal } from '../common/tenant-context.service';

// Builds a Prisma client that, for every model operation, runs inside a
// transaction that first sets `app.tenant_id` (via parameterized set_config —
// no SQL injection). Combined with the RLS policies, the database itself scopes
// every query to the current tenant. Connects as the non-owner app role so RLS
// is enforced (the owner bypasses it).
function withRls(base: PrismaClient, cls: ClsService) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const tenantId = cls.get<TenantPrincipal>('principal')?.tenantId;
          // No tenant in context (e.g. a system path) → run as-is; RLS is
          // fail-closed, so without the GUC these queries return nothing.
          if (!tenantId) {
            return query(args);
          }
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

export type RlsPrismaClient = ReturnType<typeof withRls>;

@Injectable()
export class TenantPrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly base: PrismaClient;
  /** Tenant-scoped client — use this for all tenant-owned reads/writes. */
  readonly client: RlsPrismaClient;

  constructor(config: ConfigService, cls: ClsService) {
    this.base = new PrismaClient({
      datasourceUrl: config.getOrThrow<string>('APP_DATABASE_URL'),
    });
    this.client = withRls(this.base, cls);
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }
}
