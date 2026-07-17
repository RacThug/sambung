import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Principal } from '../tenant-context.service';

/**
 * The authenticated Principal attached by JwtAuthGuard, for controllers that
 * want the caller explicitly. Services should read TenantContext instead: a
 * tenant id that arrives as a parameter is a tenant id someone can forget to
 * pass (invariant #2).
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const req = ctx.switchToHttp().getRequest<{ user: Principal }>();
    return req.user;
  },
);
