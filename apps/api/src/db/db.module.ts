import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';
import { TenantDbService } from './tenant-db.service';

// Global so any module can inject either client without re-importing.
//   DbService       — owner connection; system ops (auth, seed), bypasses RLS.
//   TenantDbService — app-role connection; tenant-scoped queries, RLS enforced.
@Global()
@Module({
  providers: [DbService, TenantDbService],
  exports: [DbService, TenantDbService],
})
export class DbModule {}
