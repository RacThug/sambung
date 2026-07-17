import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

/**
 * The authenticated actor, for the duration of one request. The single shape:
 * the guard mints it from the access token, services read tenantId off it, and
 * TenantDbService scopes the database to it.
 *
 * Not the token's shape - JWT's `sub` stays in AccessPayload, where JWT's
 * vocabulary belongs, and auth.guard translates. This is the domain's.
 */
export interface Principal {
  userId: string;
  tenantId: string;
  role: 'owner' | 'staff';
}

// Private on purpose. Nothing outside this file should know the principal is
// stored in CLS, let alone under which key - go through TenantContext. When
// TenantDbService read this literal itself, renaming the key silently broke
// RLS scoping to zero rows; now it is a compile error.
const PRINCIPAL_KEY = 'principal';

// Ambient per-request access to the authenticated principal (AsyncLocalStorage,
// via nestjs-cls). Services read tenantId here instead of threading it through
// every call — one forgotten parameter can't become a cross-tenant leak.
@Injectable()
export class TenantContext {
  constructor(private readonly cls: ClsService) {}

  set(principal: Principal): void {
    this.cls.set(PRINCIPAL_KEY, principal);
  }

  get principal(): Principal | undefined {
    return this.cls.get<Principal>(PRINCIPAL_KEY);
  }

  /** The current tenant id. Throws if used outside an authenticated request. */
  get tenantId(): string {
    const principal = this.principal;
    if (!principal) {
      throw new Error('Tenant context is empty — route must be authenticated');
    }
    return principal.tenantId;
  }
}
