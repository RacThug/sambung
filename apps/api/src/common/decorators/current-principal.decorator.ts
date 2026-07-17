import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { UserPrincipal } from '../tenant-context.service';

/**
 * The authenticated user attached by JwtAuthGuard, for controllers that want the
 * caller explicitly. Services should read TenantContext instead: a tenant id
 * that arrives as a parameter is a tenant id someone can forget to pass
 * (invariant #2).
 *
 * UserPrincipal, not the Principal union: this reads `req.user`, which ONLY
 * JwtAuthGuard sets. A Visitor never has one - PublicScope mints a principal
 * into the tenant context, not onto the request - so a route reaching for this
 * decorator has already declared it is authenticated.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserPrincipal => {
    const req = ctx.switchToHttp().getRequest<{ user: UserPrincipal }>();
    return req.user;
  },
);
