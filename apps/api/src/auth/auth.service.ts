import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { appUser, membership, tenant, type AppUser } from '@sambung/db';
import type {
  AuthResponse,
  LoginRequest,
  MembershipDto,
  MeResponse,
  RegisterRequest,
  UserDto,
} from '@sambung/shared';
import { emailTaken } from '../common/db-error/conflicts';
import { DbService } from '../db/db.service';

const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';
const BCRYPT_ROUNDS = 12;

/**
 * The refresh token's payload.
 *
 * `tenantId` is OPTIONAL, and that is a compatibility affordance rather than a
 * modelling choice (#154): tokens minted before memberships existed carry only
 * `sub`, and a deploy should not sign everyone out. A payload without it falls
 * back to the default membership, exactly as a fresh login would.
 */
interface RefreshPayload {
  sub: string;
  tenantId?: string;
}

/** One membership, joined to its tenant's name, in default-first order. */
interface MembershipRow {
  tenantId: string;
  tenantName: string;
  role: MembershipDto['role'];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly dbs: DbService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Signup: create a tenant, its owner's account, and the membership joining them. */
  async register(
    input: RegisterRequest,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const db = this.dbs.db;
    const [existing] = await db
      .select({ id: appUser.id })
      .from(appUser)
      .where(eq(appUser.email, input.email))
      .limit(1);
    if (existing) {
      // Still a refusal, and deliberately so after #154: memberships make one
      // account CAPABLE of holding a second tenant, but register is
      // unauthenticated - it cannot know the caller is that account holder, and
      // attaching a workspace to someone else's login on the strength of a typed
      // address is not a thing to do. "Create another workspace" is an
      // authenticated verb, and it does not exist yet (ADR-0034).
      //
      // Same factory the constraint maps to, so the two layers are literally the
      // same response - api-spec §5.3. This branch is only a fast path: it exists
      // to skip the 12-round bcrypt below, not to guarantee anything.
      throw emailTaken();
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    // The citext UNIQUE on email is the real guard: two concurrent signups both
    // pass the pre-check above (bcrypt holds the window open for ~300ms), then
    // one loses at the constraint. No try/catch - DbErrorInterceptor maps
    // app_user_email_key to the same 409, so the loser cannot tell which layer
    // refused it.
    //
    // Tenant, account and membership are created together or not at all.
    const newUser = await db.transaction(async (tx) => {
      const [newTenant] = await tx
        .insert(tenant)
        .values({ name: input.tenantName })
        .returning();
      const [created] = await tx
        .insert(appUser)
        .values({ email: input.email, passwordHash })
        .returning();
      await tx.insert(membership).values({
        appUserId: created.id,
        tenantId: newTenant.id,
        role: 'owner',
      });
      return created;
    });
    return this.issue(newUser);
  }

  async login(
    input: LoginRequest,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const user = await this.findUser(eq(appUser.email, input.email));
    // Same error whether the email or the password is wrong — don't leak which.
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.issue(user);
  }

  async refresh(
    refreshToken: string | undefined,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const user = await this.findUser(eq(appUser.id, payload.sub));
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    // A tenantId that no longer names a membership falls back to the default
    // rather than failing: losing one seat should not end a session that another
    // seat still justifies. The scope is re-read from the database here, so a
    // revoked membership cannot be refreshed back into existence.
    return this.issue(user, payload.tenantId);
  }

  /**
   * Act in a different Tenant (#154, ADR-0034).
   *
   * The caller is already authenticated, so the only question is whether THIS
   * user holds a membership at that tenant. A 404 when they do not - never a
   * 403 - because "no" and "there is no such tenant" must be one answer, or this
   * becomes a way to enumerate the tenants of Sambung one uuid at a time.
   */
  async switchTenant(
    userId: string,
    tenantId: string,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const user = await this.findUser(eq(appUser.id, userId));
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    const [held] = await this.dbs.db
      .select({ tenantId: membership.tenantId })
      .from(membership)
      .where(
        and(
          eq(membership.appUserId, userId),
          eq(membership.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!held) {
      throw new NotFoundException('No such workspace');
    }
    return this.issue(user, tenantId);
  }

  async me(userId: string, tenantId: string): Promise<MeResponse> {
    const user = await this.findUser(eq(appUser.id, userId));
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    const memberships = await this.membershipsOf(userId);
    const active = memberships.find((m) => m.tenantId === tenantId);
    if (!active) {
      // The token names a tenant this account is no longer a member of. It stays
      // cryptographically valid until it expires, but it now describes a seat
      // that does not exist - and every scoped read behind it already returns
      // nothing, because RLS reads `membership`, not the token (ADR-0032).
      throw new UnauthorizedException('Membership no longer exists');
    }
    return {
      user: this.toUserDto(user, active),
      tenant: { id: active.tenantId, name: active.tenantName },
      memberships: memberships.map(toMembershipDto),
    };
  }

  /**
   * Start a session for a user this service did not authenticate.
   *
   * The one caller is accepting a staff Invite (#57): the invite token IS the
   * proof of identity, verified by InvitesService, and what remains is exactly
   * what login does after a correct password. Exposing this rather than letting
   * the staff module sign its own tokens keeps ONE place that decides what an
   * access token contains - a second signer is how `role` ends up in the payload
   * on one path and missing on the other.
   *
   * Named to be uncomfortable to call by accident: it authenticates nothing.
   */
  async startSessionForVerifiedUser(
    user: AppUser,
    tenantId: string,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    return this.issue(user, tenantId);
  }

  /** One account by any appUser predicate, or undefined. */
  private async findUser(
    where: ReturnType<typeof eq>,
  ): Promise<AppUser | undefined> {
    const [row] = await this.dbs.db
      .select()
      .from(appUser)
      .where(where)
      .limit(1);
    return row;
  }

  /**
   * Every Tenant this account can act in, DEFAULT FIRST.
   *
   * The order is the default-membership rule and lives in exactly one place:
   * owners before staff, then oldest first. Deterministic and stored nowhere - a
   * "last used tenant" column would be a write on every login to save one click,
   * and the switcher is that click.
   */
  private async membershipsOf(userId: string): Promise<MembershipRow[]> {
    return this.dbs.db
      .select({
        tenantId: membership.tenantId,
        tenantName: tenant.name,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(tenant, eq(membership.tenantId, tenant.id))
      .where(eq(membership.appUserId, userId))
      .orderBy(
        desc(sql`${membership.role} = 'owner'`),
        asc(membership.createdAt),
      );
  }

  private async issue(
    user: AppUser,
    preferredTenantId?: string,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const memberships = await this.membershipsOf(user.id);
    if (memberships.length === 0) {
      // Reachable only AFTER a correct password (or a valid token), so it is not
      // an account-existence oracle - and answering "invalid credentials" to
      // someone whose credentials were valid would send them to reset a password
      // that works. The honest answer is that the seats are gone.
      throw new ForbiddenException(
        'This account is not a member of any workspace. Ask an owner to invite you again.',
      );
    }
    const active =
      memberships.find((m) => m.tenantId === preferredTenantId) ??
      memberships[0];

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, tenantId: active.tenantId, role: active.role },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: ACCESS_TTL,
      },
    );
    // The refresh token carries the tenant too, so a refresh lands back in the
    // membership the session was actually in rather than the default one.
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, tenantId: active.tenantId } satisfies RefreshPayload,
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: REFRESH_TTL,
      },
    );
    return {
      auth: {
        accessToken,
        user: this.toUserDto(user, active),
        tenant: { id: active.tenantId, name: active.tenantName },
        memberships: memberships.map(toMembershipDto),
      },
      refreshToken,
    };
  }

  private toUserDto(user: AppUser, active: MembershipRow): UserDto {
    return {
      id: user.id,
      email: user.email,
      // Both describe the ACTIVE membership, not the person (#154).
      role: active.role,
      tenantId: active.tenantId,
    };
  }
}

function toMembershipDto(row: MembershipRow): MembershipDto {
  return { tenantId: row.tenantId, tenantName: row.tenantName, role: row.role };
}
