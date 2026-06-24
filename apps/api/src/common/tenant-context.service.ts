import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

export interface TenantPrincipal {
  userId: string;
  tenantId: string;
  role: 'owner' | 'staff';
}

const PRINCIPAL_KEY = 'principal';

// Ambient per-request access to the authenticated principal (AsyncLocalStorage,
// via nestjs-cls). Services read tenantId here instead of threading it through
// every call — one forgotten parameter can't become a cross-tenant leak.
@Injectable()
export class TenantContext {
  constructor(private readonly cls: ClsService) {}

  set(principal: TenantPrincipal): void {
    this.cls.set(PRINCIPAL_KEY, principal);
  }

  get principal(): TenantPrincipal | undefined {
    return this.cls.get<TenantPrincipal>(PRINCIPAL_KEY);
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
