import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  appUser,
  property,
  staffInvite,
  staffInviteProperty,
  tenant,
  userProperty,
  type AppUser,
  type Tenant,
} from '@sambung/db';
import type { InviteRefusalReason } from '@sambung/shared';
import { DbService } from '../db/db.service';

export interface InviteView {
  id: string;
  tenantId: string;
  tenantName: string;
  email: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  invitedBy: string;
  propertyNames: string[];
}

/**
 * The unauthenticated half of the Invite lifecycle: preview and accept.
 *
 * Runs on the OWNER connection (`DbService`, RLS-bypassed), like register and
 * login - and for the same reason, not as a shortcut. There is no principal to
 * scope by: the caller has no account yet, and the thing they are asking about
 * is precisely which Tenant they are about to belong to. The alternatives were
 * both worse than they look:
 *
 *   - a Visitor scoped from the token (ADR-0003's shape) would be minting a
 *     principal for someone who is about to become a real user, and would still
 *     need an RLS-bypassed read to resolve the tenant from the token first;
 *   - running the INSERT under RLS is impossible by construction - the row it
 *     creates is the thing that would grant the scope.
 *
 * What makes that safe is the same thing that makes the .ics export safe
 * (ADR-0016): every statement is keyed by a 256-bit unguessable value, or by an
 * id already resolved from one. There is no caller-supplied tenant, no listing,
 * and no query here whose blast radius is wider than one invite.
 */
@Injectable()
export class InviteAcceptRepository {
  constructor(private readonly dbs: DbService) {}

  /** Resolve an invite by its token hash. Returns the closure timestamps too, so
   * the caller can say WHY a dead invite is dead without a second read. */
  async findByTokenHash(tokenHash: string): Promise<InviteView | undefined> {
    const db = this.dbs.db;
    const [row] = await db
      .select({
        id: staffInvite.id,
        tenantId: staffInvite.tenantId,
        tenantName: tenant.name,
        email: staffInvite.email,
        expiresAt: staffInvite.expiresAt,
        acceptedAt: staffInvite.acceptedAt,
        revokedAt: staffInvite.revokedAt,
        invitedBy: appUser.email,
      })
      .from(staffInvite)
      .innerJoin(tenant, eq(tenant.id, staffInvite.tenantId))
      .innerJoin(appUser, eq(appUser.id, staffInvite.createdBy))
      .where(eq(staffInvite.tokenHash, tokenHash))
      .limit(1);
    if (!row) return undefined;

    const names = await db
      .select({ name: property.name })
      .from(staffInviteProperty)
      .innerJoin(property, eq(property.id, staffInviteProperty.propertyId))
      .where(eq(staffInviteProperty.inviteId, row.id))
      .orderBy(asc(property.name));
    return { ...row, propertyNames: names.map((n) => n.name) };
  }

  /**
   * Accept: spend the invite, create the staff user, copy the grants across.
   *
   * ONE transaction, and the ORDER is the concurrency control. The guarded
   * UPDATE goes first, so two simultaneous accepts of the same token contend on
   * that row: the winner proceeds, the loser matches zero rows and is refused
   * before it can create a second account. Checking first and updating last
   * would leave exactly the read-then-write window boss fight #1 exists to
   * teach.
   *
   * The WHERE re-states every liveness condition rather than trusting the read
   * the caller already did - that read happened outside this transaction, so it
   * is a hint, not a guarantee.
   *
   * `expires_at > now()` is evaluated by the DATABASE, not by Node. One clock
   * decides whether an invite is live, and it is the same clock that stamped it.
   *
   * Returns `undefined` when the invite was not live, leaving the caller to
   * re-read it and name the reason. A duplicate email raises
   * `app_user_email_key`, which the interceptor maps to the same `email_taken`
   * 409 registration gives (§5.3) - the accept path deliberately has no
   * pre-check of its own for it.
   */
  async accept(input: {
    inviteId: string;
    passwordHash: string;
  }): Promise<{ user: AppUser; tenant: Tenant } | undefined> {
    return this.dbs.db.transaction(async (tx) => {
      const [spent] = await tx
        .update(staffInvite)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(staffInvite.id, input.inviteId),
            isNull(staffInvite.acceptedAt),
            isNull(staffInvite.revokedAt),
            sql`${staffInvite.expiresAt} > now()`,
          ),
        )
        .returning({
          id: staffInvite.id,
          tenantId: staffInvite.tenantId,
          email: staffInvite.email,
        });
      if (!spent) return undefined;

      const [newUser] = await tx
        .insert(appUser)
        .values({
          tenantId: spent.tenantId,
          email: spent.email,
          passwordHash: input.passwordHash,
          role: 'staff',
        })
        .returning();

      // The Assignments, copied from the invite. A single INSERT ... SELECT
      // rather than a read-then-insert: the set is whatever the invite grants at
      // this instant, and there is no version of it in application memory to
      // disagree with the row. `tenant_id` comes from the invite's own rows, so
      // the composite FKs have nothing to reject.
      await tx.insert(userProperty).select(
        tx
          .select({
            appUserId: sql`${newUser.id}::uuid`.as('app_user_id'),
            propertyId: staffInviteProperty.propertyId,
            tenantId: staffInviteProperty.tenantId,
          })
          .from(staffInviteProperty)
          .where(eq(staffInviteProperty.inviteId, spent.id)),
      );

      const [tenantRow] = await tx
        .select()
        .from(tenant)
        .where(eq(tenant.id, spent.tenantId))
        .limit(1);
      return { user: newUser, tenant: tenantRow };
    });
  }
}

/** Why a resolved-but-dead invite is dead. Checked in the order a human would
 * explain it: withdrawn beats spent beats lapsed. */
export function refusalReason(invite: InviteView): InviteRefusalReason {
  if (invite.revokedAt) return 'revoked';
  if (invite.acceptedAt) return 'accepted';
  return 'expired';
}
