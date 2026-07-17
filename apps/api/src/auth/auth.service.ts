import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { appUser, tenant, type AppUser, type Tenant } from '@sambung/db';
import type {
  AuthResponse,
  LoginRequest,
  MeResponse,
  RegisterRequest,
  UserDto,
} from '@sambung/shared';
import { emailTaken } from '../common/db-error/conflicts';
import { DbService } from '../db/db.service';

const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';
const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly dbs: DbService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Signup: create a tenant + its owner user, then start a session. */
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
      // Same factory the constraint maps to, so the two layers are literally
      // the same response - api-spec §5.3. This branch is only a fast path: it
      // exists to skip the 12-round bcrypt below, not to guarantee anything.
      throw emailTaken();
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    // The citext UNIQUE on email is the real guard: two concurrent signups both
    // pass the pre-check above (bcrypt holds the window open for ~300ms), then
    // one loses at the constraint. No try/catch - DbErrorInterceptor maps
    // app_user_email_key to the same 409, so the loser cannot tell which layer
    // refused it.
    //
    // Tenant + owner are created together or not at all.
    const { newTenant, newUser } = await db.transaction(async (tx) => {
      const [newTenant] = await tx
        .insert(tenant)
        .values({ name: input.tenantName })
        .returning();
      const [newUser] = await tx
        .insert(appUser)
        .values({
          tenantId: newTenant.id,
          email: input.email,
          passwordHash,
          role: 'owner',
        })
        .returning();
      return { newTenant, newUser };
    });
    return this.issue(newUser, newTenant);
  }

  async login(
    input: LoginRequest,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const row = await this.findUserWithTenant(eq(appUser.email, input.email));
    // Same error whether the email or the password is wrong — don't leak which.
    if (
      !row ||
      !(await bcrypt.compare(input.password, row.user.passwordHash))
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.issue(row.user, row.tenant);
  }

  async refresh(
    refreshToken: string | undefined,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync<{ sub: string }>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const row = await this.findUserWithTenant(eq(appUser.id, payload.sub));
    if (!row) {
      throw new UnauthorizedException('User no longer exists');
    }
    return this.issue(row.user, row.tenant);
  }

  async me(userId: string): Promise<MeResponse> {
    const row = await this.findUserWithTenant(eq(appUser.id, userId));
    if (!row) {
      throw new UnauthorizedException('User no longer exists');
    }
    return {
      user: this.toUserDto(row.user),
      tenant: { id: row.tenant.id, name: row.tenant.name },
    };
  }

  /** One user + their tenant, or undefined. `where` is an appUser predicate. */
  private async findUserWithTenant(
    where: ReturnType<typeof eq>,
  ): Promise<{ user: AppUser; tenant: Tenant } | undefined> {
    const [row] = await this.dbs.db
      .select({ user: appUser, tenant: tenant })
      .from(appUser)
      .innerJoin(tenant, eq(appUser.tenantId, tenant.id))
      .where(where)
      .limit(1);
    return row;
  }

  private async issue(
    user: AppUser,
    tenantRow: Tenant,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, tenantId: tenantRow.id, role: user.role },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: ACCESS_TTL,
      },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: REFRESH_TTL,
      },
    );
    return {
      auth: {
        accessToken,
        user: this.toUserDto(user),
        tenant: { id: tenantRow.id, name: tenantRow.name },
      },
      refreshToken,
    };
  }

  private toUserDto(user: AppUser): UserDto {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };
  }
}
