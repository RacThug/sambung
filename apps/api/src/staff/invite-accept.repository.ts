import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  appUser,
  membership,
  property,
  staffInvite,
  staffInviteProperty,
  tenant,
  userProperty,
  type AppUser,
  type DbTx,
} from '@sambung/db';
import { DbService } from '../db/db.service';
import type { InviteView } from './invite-liveness';

/**
 * The account an invite for this address would land on.
 *
 * `seatCount` is what decides whether the invitee SETS a password or PROVES one
 * - see `inviteAcceptModeFor`, which owns that rule for both the preview and
 * the accept.
 */
export interface AccountForInvite {
  id: string;
  passwordHash: string;
  seatCount: number;
}

/**
 * The account turned out to be live, so the invite holder must prove they hold
 * it. Thrown INSIDE the accept transaction, so raising it un-spends the invite.
 */
export class PasswordRequiredError extends Error {
  constructor() {
    super('This account requires its password');
  }
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
   * The account for this address, anywhere in Sambung, or undefined.
   *
   * `app_user_email_key` is global (see the schema comment on `app_user.email`),
   * so this cannot be asked under RLS - which by design shows only our own
   * tenant's users. Before #154 the answer was a refusal: an existing account
   * anywhere meant the invite could never be accepted. Now it is a FORK. An
   * existing account gets a membership added to it, once the caller proves they
   * hold it, so this returns the hash rather than a boolean.
   *
   * Asking globally leaks nothing new: `POST /auth/register` already answers
   * "does this address have an account?" to anyone at all, unauthenticated.
   */
  async findAccountByEmail(
    email: string,
  ): Promise<AccountForInvite | undefined> {
    const [row] = await this.dbs.db
      .select({
        id: appUser.id,
        passwordHash: appUser.passwordHash,
        // How many Tenants this account can act in. Zero means INERT - it cannot
        // sign in and guards nothing - which `inviteAcceptModeFor` treats as
        // claimable. A count, not a boolean, so the caller states its own rule.
        seatCount: sql<number>`(
          select count(*)::int from ${membership}
          where ${membership.appUserId} = ${appUser.id}
        )`,
      })
      .from(appUser)
      .where(eq(appUser.email, email))
      .limit(1);
    return row;
  }

  /** Is this address already a member of THIS tenant? The invite-time refusal. */
  async isMemberOfTenant(email: string, tenantId: string): Promise<boolean> {
    const rows = await this.dbs.db
      .select({ id: appUser.id })
      .from(appUser)
      .innerJoin(membership, eq(membership.appUserId, appUser.id))
      .where(and(eq(appUser.email, email), eq(membership.tenantId, tenantId)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Accept: spend the invite, seat the user, copy the Assignments across.
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
   * **The account decision is made HERE, not by the caller** (#154). The caller
   * has already done the expensive half - comparing a password with bcrypt,
   * necessarily outside this transaction, because holding a row lock for ~300 ms
   * of CPU is how a hot path becomes a queue (ADR-0033) - and passes the result
   * in as `verifiedUserId`. But whether verification was REQUIRED is re-decided
   * in here, against a locked row, because the caller decided it from a read
   * taken seconds earlier on the strength of which this transaction must not act.
   *
   * That matters for exactly one case: an inert account (no seats) is claimable
   * by the invite holder, and a live one is not. If it gained a seat between the
   * preview and now, this throws `PasswordRequiredError` and the whole
   * transaction ROLLS BACK - so the invite is not spent, and the holder can try
   * again with the password the page will now ask them for. Burning a link that
   * exists in one email over a race would be the worse failure.
   *
   * Returns `undefined` when the invite was not live, leaving the caller to
   * re-read it and name the reason. A duplicate email raises
   * `app_user_email_key`, which the interceptor maps to the same `email_taken`
   * 409 registration gives (§5.3) - the accept path deliberately has no
   * pre-check of its own for it.
   */
  async accept(input: {
    inviteId: string;
    /** The password the invitee typed, hashed. Used only when claiming. */
    passwordHash: string;
    /** Set iff the caller verified that password against an existing account. */
    verifiedUserId?: string;
  }): Promise<{ user: AppUser; tenantId: string } | undefined> {
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

      // FOR UPDATE: the seat count decided below must not change under us, and
      // this is the row a concurrent accept for the same address would touch.
      const [existing] = await tx
        .select({ id: appUser.id })
        .from(appUser)
        .where(eq(appUser.email, spent.email))
        .limit(1)
        .for('update');

      let user: AppUser | undefined;
      if (!existing) {
        user = await createAccount(tx, spent.email, input.passwordHash);
      } else if (input.verifiedUserId === existing.id) {
        // A live account whose password the caller checked. Nothing to set.
        user = await loadAccount(tx, existing.id);
      } else {
        // An account the caller did not verify. Claimable only while it is inert
        // - no seats, so it cannot sign in and guards nothing. Re-counted inside
        // the lock, so a seat granted since the preview flips this to a refusal
        // rather than letting an invite holder reset a working password.
        const [{ seats }] = await tx
          .select({ seats: sql<number>`count(*)::int` })
          .from(membership)
          .where(eq(membership.appUserId, existing.id));
        if (seats > 0) throw new PasswordRequiredError();
        user = await reclaimAccount(tx, existing.id, input.passwordHash);
      }
      /* istanbul ignore next - resolved from a row read moments ago, in-txn. */
      if (!user) return undefined;

      // The seat. `DO NOTHING` rather than a pre-check: the only way this row can
      // already exist is a membership created between the invite and its accept,
      // and the safe outcome is to leave whatever role is already there alone -
      // an owner accepting a staff invite to their own tenant must not be
      // demoted by it. Inserting a seat that exists is not an error worth a 409.
      await tx
        .insert(membership)
        .values({
          appUserId: user.id,
          tenantId: spent.tenantId,
          role: 'staff',
        })
        .onConflictDoNothing();

      // The Assignments, copied from the invite. A single INSERT ... SELECT
      // rather than a read-then-insert: the set is whatever the invite grants at
      // this instant, and there is no version of it in application memory to
      // disagree with the row. `tenant_id` comes from the invite's own rows, so
      // the composite FKs have nothing to reject.
      await tx
        .insert(userProperty)
        .select(
          tx
            .select({
              appUserId: sql`${user.id}::uuid`.as('app_user_id'),
              propertyId: staffInviteProperty.propertyId,
              tenantId: staffInviteProperty.tenantId,
            })
            .from(staffInviteProperty)
            .where(eq(staffInviteProperty.inviteId, spent.id)),
        )
        .onConflictDoNothing();

      return { user, tenantId: spent.tenantId };
    });
  }
}

/** A brand-new identity for the address the invite names. */
async function createAccount(
  tx: DbTx,
  email: string,
  passwordHash: string,
): Promise<AppUser | undefined> {
  const [created] = await tx
    .insert(appUser)
    .values({ email, passwordHash })
    .returning();
  return created;
}

/**
 * An inert identity (no seats), claimed by whoever holds the invite token.
 *
 * The one place this codebase overwrites a password without checking the old
 * one. Safe because the row guards nothing - see `inviteAcceptModeFor` - and
 * because the caller has re-counted the seats inside the transaction's lock.
 */
async function reclaimAccount(
  tx: DbTx,
  userId: string,
  passwordHash: string,
): Promise<AppUser | undefined> {
  const [updated] = await tx
    .update(appUser)
    .set({ passwordHash })
    .where(eq(appUser.id, userId))
    .returning();
  return updated;
}

/** The identity that already exists, whose password the caller just proved. */
async function loadAccount(
  tx: DbTx,
  userId: string,
): Promise<AppUser | undefined> {
  const [found] = await tx
    .select()
    .from(appUser)
    .where(eq(appUser.id, userId))
    .limit(1);
  return found;
}
