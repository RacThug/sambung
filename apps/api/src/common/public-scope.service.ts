import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { booking, property, unit } from '@sambung/db';
import { DbService } from '../db/db.service';
import { TenantContext } from './tenant-context.service';

/**
 * How an unauthenticated request reaches the database (ADR-0003, #77).
 *
 * THE PROBLEM. A Visitor has no token, so nothing mints a principal, so
 * `app.tenant_id` is never set and TenantDbService.run throws. And it cannot
 * simply be handed a tenant, because the public funnel's entry point is a
 * chicken-and-egg: `GET /public/properties/:slug` is a CROSS-TENANT lookup. You
 * cannot scope by tenant before finding the property, because the property is
 * what tells you the tenant.
 *
 * THE SHAPE. Resolve, then scope. The single statement below crosses tenants on
 * the owner connection; it reads ONE column, keyed by a value that exists to be
 * public. Everything a Visitor actually sees is fetched afterwards, under RLS,
 * as the resolved tenant. So when `property` grows a payout account or a phone
 * number, this step cannot leak it - it doesn't select it.
 *
 * WHY A PRINCIPAL, NOT `runAsTenant(tenantId, fn)`. #77 drafted the latter, and
 * it would undo the ADR of #76: it puts a tenant id back on a parameter list, on
 * the very class that enforces boss fight #5, where any caller could name any
 * tenant. Minting a principal instead means nothing downstream changes - run and
 * every repository read the tenant ambiently, exactly as they do for an Owner -
 * and a mistake is confined to the tenant whose URL the Visitor already typed.
 *
 * WHY NOT A GUARD. Symmetry with JwtAuthGuard is tempting, but "which tenant
 * owns this slug" is a lookup and "unknown slug" is a 404 - a domain answer, not
 * "you may not proceed". M2's `POST /public/bookings` also carries its unit id
 * in the body, which a guard would have to read before anything validated it.
 * Revisit once three real callers exist.
 *
 * This is the only class in the API that may query across tenants on behalf of
 * an unauthenticated request. Keep its surface this small: it is what a reviewer
 * greps for.
 */
@Injectable()
export class PublicScope {
  constructor(
    private readonly dbs: DbService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * Enter the scope of the tenant that owns `slug`, so the caller's subsequent
   * queries run under RLS as that tenant.
   *
   * Throws 404 for an unknown slug - the same answer, and the same shape, a
   * Visitor gets for a property that exists but belongs to nobody they can see.
   * There is no other outcome: a slug either addresses a property or it does not.
   */
  async enterFromSlug(slug: string): Promise<void> {
    const [found] = await this.dbs.db
      .select({ tenantId: property.tenantId })
      .from(property)
      .where(eq(property.slug, slug))
      .limit(1);
    if (!found) {
      throw new NotFoundException('Property not found');
    }
    this.tenant.set({ kind: 'visitor', tenantId: found.tenantId });
  }

  /**
   * Enter the scope of the tenant that owns the Unit `unitId`, so the caller's
   * subsequent queries run under RLS as that tenant.
   *
   * The second public entry (api-spec §5.1, the availability quote). Symmetric
   * with enterFromSlug, and PURE for the same reason (ADR-0008): it resolves the
   * tenant for ANY existing Unit - archived included - and 404s only a Unit that
   * does not exist. What an archived Unit MEANS is decided downstream at the
   * chokepoint: the quote read answers 404 (§4.8, AvailabilityService), the M2
   * booking write answers 409. A resolver that judged archive here would make
   * that resolve-then-409 impossible and split one cross-tenant lookup into two
   * that drift.
   *
   * One column, keyed by a deliberately-public value: the public page returns
   * `unit.id` precisely so this endpoint can address a Unit by it (api-spec §4.7).
   * It cannot leak a column a Unit later grows, because it selects only tenant_id.
   */
  async enterFromUnitId(unitId: string): Promise<void> {
    const [found] = await this.dbs.db
      .select({ tenantId: unit.tenantId })
      .from(unit)
      .where(eq(unit.id, unitId))
      .limit(1);
    if (!found) {
      throw new NotFoundException('Unit not found');
    }
    this.tenant.set({ kind: 'visitor', tenantId: found.tenantId });
  }

  /**
   * Enter the scope of the tenant that owns the booking `bookingId`, so the
   * caller's subsequent queries run under RLS as that tenant.
   *
   * The THIRD public entry (api-spec §6.1, the pay step). Same shape as its
   * siblings and PURE for the same reason (ADR-0008): it resolves the tenant for
   * ANY existing booking and 404s only an id that addresses no booking. Whether
   * the booking can actually be PAID - a live hold, not already confirmed /
   * cancelled / expired / lapsed - is decided downstream at the chokepoint
   * (BookingsService, a post-sweep status read → 409 booking_not_payable). A
   * resolver that judged status here would fold that decision into the door and
   * split one cross-tenant lookup into two that drift.
   *
   * One column, keyed by an unguessable UUID the guest already holds (it was in
   * the create response). The `payment` RLS policy scopes through this same
   * `booking.tenant_id`, so once the Visitor is minted the pay endpoint can insert
   * and read its payment row with no special connection.
   */
  async enterFromBookingId(bookingId: string): Promise<void> {
    const [found] = await this.dbs.db
      .select({ tenantId: booking.tenantId })
      .from(booking)
      .where(eq(booking.id, bookingId))
      .limit(1);
    if (!found) {
      throw new NotFoundException('Booking not found');
    }
    this.tenant.set({ kind: 'visitor', tenantId: found.tenantId });
  }
}
