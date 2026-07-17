import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

/**
 * A logged-in Owner or staff member, for the duration of one request.
 *
 * Not the token's shape - JWT's `sub` stays in AccessPayload, where JWT's
 * vocabulary belongs, and auth.guard translates. This is the domain's.
 */
export interface UserPrincipal {
  kind: 'user';
  userId: string;
  tenantId: string;
  role: 'owner' | 'staff';
}

/**
 * A Visitor: someone reading a public page, who has not booked and is not a
 * user of anyone's Tenant (CONTEXT.md). They still act inside exactly ONE
 * tenant's scope - the tenant that owns the Property whose slug they opened -
 * which is what makes them a principal rather than an absence of one.
 *
 * Minted by PublicScope, from the slug (ADR-0003). Deliberately has no userId
 * and no role: there is no one to be, and nothing to be allowed.
 */
export interface VisitorPrincipal {
  kind: 'visitor';
  tenantId: string;
}

/**
 * Whoever the current request acts for. The single shape: a guard or PublicScope
 * mints it, services read tenantId off it, and TenantDbService scopes the
 * database to it.
 *
 * A UNION rather than one shape with optional fields, so `principal.role` does
 * not compile until the Visitor case is handled. That is the whole point: a
 * Visitor must not be able to drift into a role check and pass it by looking
 * close enough to an Owner. Unrepresentable beats unlikely (boss fight #5).
 */
export type Principal = UserPrincipal | VisitorPrincipal;

// Private on purpose. Nothing outside this file should know the principal is
// stored in CLS, let alone under which key - go through TenantContext. When
// TenantDbService read this literal itself, renaming the key silently broke
// RLS scoping to zero rows; now it is a compile error.
const PRINCIPAL_KEY = 'principal';

// Ambient per-request access to the current principal (AsyncLocalStorage, via
// nestjs-cls). Services read tenantId here instead of threading it through
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

  /**
   * The current tenant id - the one question both kinds of principal answer,
   * which is why TenantDbService and every repository can read it without
   * caring whether a Visitor or an Owner is asking. RLS scopes a Visitor's
   * query exactly as it scopes an Owner's.
   *
   * Throws when nothing has been minted: a request that reached a tenant-scoped
   * query with no tenant is a bug, not a query.
   */
  get tenantId(): string {
    const principal = this.principal;
    if (!principal) {
      throw new Error(
        'Tenant context is empty — an authenticated route must run behind ' +
          'JwtAuthGuard, and a public one must enter a scope via PublicScope',
      );
    }
    return principal.tenantId;
  }
}
