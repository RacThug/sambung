import { Global, Module } from '@nestjs/common';
import { PublicScope } from './public-scope.service';
import { TenantContext } from './tenant-context.service';

// Global so the guard and every feature module share one TenantContext.
//
// PublicScope lives here rather than in a `public/` module because the public
// funnel spans property (M1), booking (M2), and payment (M3) - a module drawn
// around "is it authenticated?" would cut across every domain boundary
// architecture §3.2 draws. It's cross-cutting, like the context it seeds.
@Global()
@Module({
  providers: [TenantContext, PublicScope],
  exports: [TenantContext, PublicScope],
})
export class CommonModule {}
