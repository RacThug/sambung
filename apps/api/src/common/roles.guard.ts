import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './decorators/roles.decorator';
import { TenantContext, type UserPrincipal } from './tenant-context.service';

/**
 * Enforces `@Roles(...)` (#67). Runs AFTER JwtAuthGuard - list it second in
 * `@UseGuards`, because it reads the principal that guard mints.
 *
 * Reads TenantContext rather than `req.user`, per the "one module owns the
 * tenant principal" decision (#76): the two must not be able to disagree about
 * who is asking, and a guard is exactly where they would.
 *
 * Three refusals, all 403:
 *  - no principal: the route is misconfigured (no JwtAuthGuard, or wrong order).
 *    Fail closed rather than trust an empty context.
 *  - a Visitor: `Principal` is a union and a Visitor has no role at all
 *    (ADR-0003). A public scope reaching a role-guarded route is a wiring bug;
 *    it must never be read as "role undefined, therefore allowed".
 *  - a user whose role is not listed.
 *
 * 403 and not the 404-over-403 convention used for cross-tenant reads: hiding a
 * resource protects against an EXISTENCE oracle, and there is nothing to hide
 * here - staff know their own tenant has settings. Telling them they lack the
 * role is the honest, actionable answer.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContext,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<
      UserPrincipal['role'][] | undefined
    >(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;

    const principal = this.tenantContext.principal;
    if (!principal || principal.kind !== 'user') {
      throw new ForbiddenException('This action requires a signed-in user');
    }
    if (!required.includes(principal.role)) {
      throw new ForbiddenException(
        `This action is restricted to: ${required.join(', ')}`,
      );
    }
    return true;
  }
}
