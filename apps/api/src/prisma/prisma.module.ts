import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantPrismaService } from './tenant-prisma.service';

// Global so any module can inject either client without re-importing.
//   PrismaService       — owner connection; system ops (auth, seed), bypasses RLS.
//   TenantPrismaService — app-role connection; tenant-scoped queries, RLS enforced.
@Global()
@Module({
  providers: [PrismaService, TenantPrismaService],
  exports: [PrismaService, TenantPrismaService],
})
export class PrismaModule {}
