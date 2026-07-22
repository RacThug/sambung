import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  appUser,
  membership,
  property,
  staffInvite,
  staffInviteProperty,
  userProperty,
} from '@sambung/db';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

/** A Property an Invite or a Staff member is scoped to. */
export interface AssignedProperty {
  id: string;
  name: string;
}

/** One staff member and their Assignments. */
export interface StaffRow {
  id: string;
  email: string;
  createdAt: Date;
  properties: AssignedProperty[];
}

/**
 * One live invite and the Assignments it will make.
 *
 * A SEPARATE type from StaffRow, though the two are nearly identical. They were
 * one, and the seam showed: the staff query had to select a literal
 * `null as expires_at` for a column it has no concept of, and the invite mapper
 * then had to invent `?? new Date()` to get it back. Two shapes, honestly
 * spelled, cost less than one shape both callers have to lie to - and the domain
 * agrees (CONTEXT.md keeps Invite and Staff deliberately apart).
 */
export interface InviteRow extends StaffRow {
  expiresAt: Date;
}

/**
 * The owner's side of Team management (#57): invites, staff, assignments - all
 * through the tenant-scoped (RLS) client.
 *
 * Every route that reaches this repository is `@Roles('owner')`, so every
 * transaction it opens runs with `app.property_scope = 'all'` (ADR-0032). That
 * is not an accident to be relied on quietly: `user_property`'s WITH CHECK
 * requires it, so if a staff-scoped caller ever reached the write below, the
 * database would refuse rather than let them grant themselves a Property.
 *
 * Every statement also carries an explicit tenant/user predicate beside RLS -
 * architecture §3.3's second layer, which still holds if the API ever boots on
 * `DATABASE_URL` (owner role, no policies).
 */
@Injectable()
export class StaffRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * How many of these property ids this tenant can actually see. The caller
   * compares against the requested count and 404s on a mismatch - purely for the
   * answer's sake: correctness is the composite FK's, which makes a cross-tenant
   * assignment unrepresentable. Same division of labour as UnitsService's
   * property pre-check.
   */
  async countVisibleProperties(propertyIds: string[]): Promise<number> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(property)
        .where(
          and(
            eq(property.tenantId, tenantId),
            inArray(property.id, propertyIds),
          ),
        ),
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * A live invite already outstanding for this email? The friendly half of the
   * two-layer check; `staff_invite_live_email_uniq` is the real one.
   *
   * "Live" includes NOT EXPIRED, which the index cannot express - an index
   * predicate must be immutable, so `now()` is not available to it. That gap is
   * why `supersedeExpiredInvites` exists: this check and the index have to agree,
   * and the only way to make the index agree is to close the stale row first.
   */
  async hasLiveInvite(email: string): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ id: staffInvite.id })
        .from(staffInvite)
        .where(and(...liveInviteFor(tenantId, email)))
        .limit(1),
    );
    return rows.length > 0;
  }

  /**
   * Close any invite for this address that has simply run out of time.
   *
   * Found in review. `staff_invite_live_email_uniq` is partial on
   * `accepted_at is null and revoked_at is null` and CANNOT also test
   * `expires_at > now()`, so a lapsed invite went on occupying the one live slot
   * for its address: re-inviting answered `409 invite_already_pending` forever,
   * and the only way out was to guess that revoking a dead invite would help.
   *
   * Marking it `revoked_at` is BOOKKEEPING, not a claim about what happened -
   * `refusalReason` checks expiry before revocation precisely so the holder of
   * the stale link is still told it expired (invite-liveness.ts).
   *
   * Idempotent, and scoped to one address: it closes only rows that are already
   * dead by the clock, so running it twice changes nothing the second time.
   */
  async supersedeExpiredInvites(email: string): Promise<void> {
    const tenantId = this.tenant.tenantId;
    await this.db.run((tx) =>
      tx
        .update(staffInvite)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(staffInvite.tenantId, tenantId),
            eq(staffInvite.email, email),
            isNull(staffInvite.acceptedAt),
            isNull(staffInvite.revokedAt),
            sql`${staffInvite.expiresAt} <= now()`,
          ),
        ),
    );
  }

  /** Invite + the Properties it will assign, in ONE transaction: an invite that
   * assigns nothing is not a half-created invite, it is a bug. */
  async createInvite(input: {
    email: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string;
    propertyIds: string[];
  }): Promise<string> {
    const tenantId = this.tenant.tenantId;
    return this.db.run(async (tx) => {
      const [row] = await tx
        .insert(staffInvite)
        .values({
          tenantId,
          email: input.email,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          createdBy: input.createdBy,
        })
        .returning({ id: staffInvite.id });
      await tx.insert(staffInviteProperty).values(
        input.propertyIds.map((propertyId) => ({
          inviteId: row.id,
          propertyId,
          tenantId,
        })),
      );
      return row.id;
    });
  }

  /**
   * Pending invites - live ones only, with the Properties they will assign.
   *
   * "Pending" means an invite somebody could still accept, so an expired one is
   * excluded rather than listed with a date in the past. Found in review: it was
   * shown as pending, which made the owner's screen disagree with the accept
   * endpoint about the same row.
   */
  async listPendingInvites(): Promise<InviteRow[]> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({
          id: staffInvite.id,
          email: staffInvite.email,
          createdAt: staffInvite.createdAt,
          expiresAt: staffInvite.expiresAt,
          propertyId: property.id,
          propertyName: property.name,
        })
        .from(staffInvite)
        .leftJoin(
          staffInviteProperty,
          eq(staffInviteProperty.inviteId, staffInvite.id),
        )
        .leftJoin(property, eq(property.id, staffInviteProperty.propertyId))
        .where(and(...liveInviteFor(tenantId)))
        .orderBy(asc(staffInvite.createdAt), asc(property.name)),
    );
    return group(rows);
  }

  /**
   * Withdraw an invite. A guarded UPDATE, so revoking twice is a no-op rather
   * than an error, and revoking an already-accepted one changes nothing (the
   * seat is taken - removing THAT is `DELETE /staff/:id`). Returns whether a row
   * matched, which the service turns into 404-over-403.
   */
  async revokeInvite(inviteId: string): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .update(staffInvite)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(staffInvite.id, inviteId),
            eq(staffInvite.tenantId, tenantId),
            isNull(staffInvite.acceptedAt),
            isNull(staffInvite.revokedAt),
          ),
        )
        .returning({ id: staffInvite.id }),
    );
    if (rows.length > 0) return true;
    // Zero rows is ambiguous - unknown id, or already closed. Idempotent for the
    // latter (the invite IS dead, which is what the caller asked for), 404 for
    // the former. Same shape as the cancel FSM's existence re-read (#50).
    const existing = await this.db.run((tx) =>
      tx
        .select({ id: staffInvite.id })
        .from(staffInvite)
        .where(
          and(eq(staffInvite.id, inviteId), eq(staffInvite.tenantId, tenantId)),
        )
        .limit(1),
    );
    return existing.length > 0;
  }

  /** Staff members of this tenant, with their Assignments. */
  async listStaff(): Promise<StaffRow[]> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({
          id: appUser.id,
          email: appUser.email,
          createdAt: appUser.createdAt,
          propertyId: property.id,
          propertyName: property.name,
        })
        .from(appUser)
        // The roster is `membership`, not `app_user` (#154): the account is a
        // person who may work elsewhere too, and it is the seat at THIS tenant
        // that makes them staff here. The join is an INNER one for that reason -
        // an account with no membership here is not on this team.
        .innerJoin(membership, eq(membership.appUserId, appUser.id))
        .leftJoin(
          userProperty,
          and(
            eq(userProperty.appUserId, appUser.id),
            eq(userProperty.tenantId, tenantId),
          ),
        )
        .leftJoin(property, eq(property.id, userProperty.propertyId))
        .where(
          and(eq(membership.tenantId, tenantId), eq(membership.role, 'staff')),
        )
        .orderBy(asc(appUser.email), asc(property.name)),
    );
    return group(rows);
  }

  /** Does this id name a staff member of this tenant? The existence half of
   * 404-over-403 for the two /staff writes. */
  async staffExists(userId: string): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ id: membership.appUserId })
        .from(membership)
        .where(
          and(
            eq(membership.appUserId, userId),
            eq(membership.tenantId, tenantId),
            eq(membership.role, 'staff'),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  }

  /**
   * Replace a staff member's Assignments - a WHOLE-SET write, in ONE transaction.
   *
   * Delete-then-insert rather than a diff: the request IS the new set, and a
   * diff would be three statements computing something one DELETE already knows.
   * Atomic matters more than usual here, because the intermediate state (no
   * rows) is a staff member who can see nothing - a half-applied write would be
   * a silent lockout.
   */
  async replaceAssignments(
    userId: string,
    propertyIds: string[],
  ): Promise<void> {
    const tenantId = this.tenant.tenantId;
    await this.db.run(async (tx) => {
      await tx
        .delete(userProperty)
        .where(
          and(
            eq(userProperty.appUserId, userId),
            eq(userProperty.tenantId, tenantId),
          ),
        );
      await tx.insert(userProperty).values(
        propertyIds.map((propertyId) => ({
          appUserId: userId,
          propertyId,
          tenantId,
        })),
      );
    });
  }

  /**
   * Remove a staff member from THIS team.
   *
   * Since #154 this deletes the MEMBERSHIP, not the human. The distinction is the
   * whole issue: the same account may hold a seat at another villa owner's
   * tenant, and one owner removing someone from their team must not delete a
   * login they do not own. Their Assignments here cascade off the membership
   * (`user_property_app_user_tenant_fk`), so the seat and everything it granted
   * go together, and an account left with no seats simply cannot sign in until
   * someone invites it again.
   *
   * `role = 'staff'` in the WHERE is load-bearing: it is what stops this endpoint
   * from being a way for one owner to remove another, and it means an owner id
   * arrives as a 404 (there is no staff member by that id) rather than as a 403
   * that confirms one exists.
   *
   * Bookings are untouched either way: `booking` has no FK to a user (ADR-0002's
   * spirit - the ledger outlives the people who typed it).
   */
  async removeStaff(userId: string): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .delete(membership)
        .where(
          and(
            eq(membership.appUserId, userId),
            eq(membership.tenantId, tenantId),
            eq(membership.role, 'staff'),
          ),
        )
        .returning({ id: membership.appUserId }),
    );
    return rows.length > 0;
  }
}

/**
 * Collapse a LEFT JOIN's row-per-property into one entry per invite or staff
 * member, carrying through whatever extra columns the caller selected.
 *
 * Generic over those extras rather than over one union shape, which is what lets
 * an Invite keep its `expiresAt` and a Staff member simply not have one - no
 * fabricated column on either side.
 *
 * A LEFT join, so an invite whose only Property was deleted still appears (with
 * an empty list) rather than vanishing from the owner's screen - which is what
 * an inner join would do, turning a cascade into an invisible invite.
 */
function group<T extends { id: string; email: string; createdAt: Date }>(
  rows: (T & { propertyId: string | null; propertyName: string | null })[],
): (T & { properties: AssignedProperty[] })[] {
  const byId = new Map<string, T & { properties: AssignedProperty[] }>();
  for (const { propertyId, propertyName, ...rest } of rows) {
    let entry = byId.get(rest.id);
    if (!entry) {
      entry = { ...(rest as unknown as T), properties: [] };
      byId.set(entry.id, entry);
    }
    if (propertyId && propertyName) {
      entry.properties.push({ id: propertyId, name: propertyName });
    }
  }
  return [...byId.values()];
}

/**
 * What makes an invite LIVE: ours, open, and not yet out of time.
 *
 * One predicate builder rather than the same four conditions written wherever
 * "live" is needed - the list, the duplicate check, and (inverted) the supersede
 * sweep all have to mean exactly the same thing, or the owner's screen and the
 * accept endpoint disagree about a row. `email` is optional so the same
 * definition serves "all live invites" and "a live invite for this address".
 */
function liveInviteFor(tenantId: string, email?: string) {
  return [
    eq(staffInvite.tenantId, tenantId),
    ...(email ? [eq(staffInvite.email, email)] : []),
    isNull(staffInvite.acceptedAt),
    isNull(staffInvite.revokedAt),
    sql`${staffInvite.expiresAt} > now()`,
  ];
}
