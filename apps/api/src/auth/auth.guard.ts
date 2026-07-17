import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import {
  TenantContext,
  type Principal,
} from '../common/tenant-context.service';

// Shape of the signed access-token payload - JWT's vocabulary, not ours.
// `sub` is a registered JWT claim; the domain calls it userId. This type is the
// wire format and stops at this file.
interface AccessPayload {
  sub: string;
  tenantId: string;
  role: Principal['role'];
}

// Validates the access token from `Authorization: Bearer`, attaches req.user,
// and seeds the per-request TenantContext so services can scope by tenant_id.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContext,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: Principal }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(header.slice(7), {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      // Only token verification is caught here. Seeding the context below must
      // not be swallowed: a missing CLS store is a wiring bug and deserves a
      // 500, not a 401 that reads as "your token is bad".
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Wire → domain. The one place JWT's `sub` becomes the domain's userId.
    const principal: Principal = {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
    };
    req.user = principal;
    this.tenantContext.set(principal);
    return true;
  }
}
