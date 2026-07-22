import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  appUser,
  property,
  staffInvite,
  staffInviteProperty,
  userProperty,
} from '@sambung/db';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

/** One invite or staff member, with the Properties it grants, flattened. */
export interface GrantRow {
  id: string;
  email: string;
  createdAt: Date;
  expiresAt: Date | null;
  properties: { id: string; name: string }[];
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

  /** A live invite already outstanding for this email? The friendly half of the
   * two-layer check; `staff_invite_live_email_uniq` is the real one. */
  async hasLiveInvite(email: string): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ id: staffInvite.id })
        .from(staffInvite)
        .where(
          and(
            eq(staffInvite.tenantId, tenantId),
            eq(staffInvite.email, email),
            isNull(staffInvite.acceptedAt),
            isNull(staffInvite.revokedAt),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  }

  /** Is this email already an account in THIS tenant? RLS means the question can
   * only ever be asked about our own users, which is the point: the global
   * `app_user_email_key` answers the cross-tenant case at accept time, and no
   * pre-check here can turn into an existence oracle for another tenant. */
  async emailInUse(email: string): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ id: appUser.id })
        .from(appUser)
        .where(and(eq(appUser.tenantId, tenantId), eq(appUser.email, email)))
        .limit(1),
    );
    return rows.length > 0;
  }

  /** Invite + its granted properties, in ONE transaction: an invite that grants
   * nothing is not a half-created invite, it is a bug. */
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

  /** Pending (live) invites with their granted property names. */
  async listPendingInvites(): Promise<GrantRow[]> {
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
        .where(
          and(
            eq(staffInvite.tenantId, tenantId),
            isNull(staffInvite.acceptedAt),
            isNull(staffInvite.revokedAt),
          ),
        )
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
  async listStaff(): Promise<GrantRow[]> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({
          id: appUser.id,
          email: appUser.email,
          createdAt: appUser.createdAt,
          expiresAt: sql<Date | null>`null`,
          propertyId: property.id,
          propertyName: property.name,
        })
        .from(appUser)
        .leftJoin(userProperty, eq(userProperty.appUserId, appUser.id))
        .leftJoin(property, eq(property.id, userProperty.propertyId))
        .where(and(eq(appUser.tenantId, tenantId), eq(appUser.role, 'staff')))
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
        .select({ id: appUser.id })
        .from(appUser)
        .where(
          and(
            eq(appUser.id, userId),
            eq(appUser.tenantId, tenantId),
            eq(appUser.role, 'staff'),
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
   * Remove a staff account. `role = 'staff'` in the WHERE is load-bearing: it is
   * what stops this endpoint from being a way for one owner to delete another,
   * and it means an owner id arrives as a 404 (there is no staff member by that
   * id) rather than as a 403 that confirms one exists.
   *
   * `user_property` rows cascade. Bookings do not: `booking` has no FK to a user
   * (ADR-0002's spirit - the ledger outlives the people who typed it).
   */
  async removeStaff(userId: string): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .delete(appUser)
        .where(
          and(
            eq(appUser.id, userId),
            eq(appUser.tenantId, tenantId),
            eq(appUser.role, 'staff'),
          ),
        )
        .returning({ id: appUser.id }),
    );
    return rows.length > 0;
  }
}

/**
 * Collapse a LEFT JOIN's row-per-property into one entry per invite/user.
 *
 * A left join, so an invite whose only Property was deleted still appears (with
 * an empty list) rather than vanishing from the owner's screen - which is what
 * an inner join would do, turning a cascade into an invisible invite.
 */
function group(
  rows: {
    id: string;
    email: string;
    createdAt: Date;
    expiresAt: Date | null;
    propertyId: string | null;
    propertyName: string | null;
  }[],
): GrantRow[] {
  const byId = new Map<string, GrantRow>();
  for (const row of rows) {
    let entry = byId.get(row.id);
    if (!entry) {
      entry = {
        id: row.id,
        email: row.email,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        properties: [],
      };
      byId.set(row.id, entry);
    }
    if (row.propertyId && row.propertyName) {
      entry.properties.push({ id: row.propertyId, name: row.propertyName });
    }
  }
  return [...byId.values()];
}
