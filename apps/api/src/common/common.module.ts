import { Global, Module } from '@nestjs/common';
import { PublicScope } from './public-scope.service';
import { RolesGuard } from './roles.guard';
import { TenantContext } from './tenant-context.service';

// Global so the guard and every feature module share one TenantContext.
//
// PublicScope lives here rather than in a `public/` module because the public
// funnel spans property (M1), booking (M2), and payment (M3) - a module drawn
// around "is it authenticated?" would cut across every domain boundary
// architecture §3.2 draws. It's cross-cutting, like the context it seeds.
// RolesGuard is registered (not APP_GUARD) so `@UseGuards(JwtAuthGuard,
// RolesGuard)` resolves it from any module: it enforces `@Roles(...)` and is a
// no-op wherever that decorator is absent, so opting in per route keeps the
// decision beside the route - the same shape as @ThrottleSensitive (#59).
@Global()
@Module({
  providers: [TenantContext, PublicScope, RolesGuard],
  exports: [TenantContext, PublicScope, RolesGuard],
})
export class CommonModule {}
