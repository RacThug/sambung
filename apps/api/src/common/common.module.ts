import { Global, Module } from '@nestjs/common';
import { TenantContext } from './tenant-context.service';

// Global so the guard and every feature module share one TenantContext.
@Global()
@Module({
  providers: [TenantContext],
  exports: [TenantContext],
})
export class CommonModule {}
