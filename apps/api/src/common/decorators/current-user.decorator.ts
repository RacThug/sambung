import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// The authenticated principal attached by JwtAuthGuard. Carries tenant_id so
// services can scope every query by it (invariant #2; isolation hardened in #8).
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: 'owner' | 'staff';
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return req.user;
  },
);
