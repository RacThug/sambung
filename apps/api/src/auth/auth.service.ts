import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { Prisma, type AppUser, type Tenant } from '@sambung/db';
import type {
  AuthResponse,
  LoginRequest,
  MeResponse,
  RegisterRequest,
  UserDto,
} from '@sambung/shared';
import { PrismaService } from '../prisma/prisma.service';

const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';
const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Signup: create a tenant + its owner user, then start a session. */
  async register(
    input: RegisterRequest,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const existing = await this.prisma.appUser.findUnique({
      where: { email: input.email },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    // The pre-check above is just UX fast-path; the citext UNIQUE on email is
    // the real guard (two concurrent signups both pass the pre-check, then one
    // loses at the constraint). Map that P2002 to 409 instead of a 500.
    try {
      // Tenant + owner are created together or not at all.
      const { tenant, user } = await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: { name: input.tenantName },
        });
        const user = await tx.appUser.create({
          data: {
            tenantId: tenant.id,
            email: input.email,
            passwordHash,
            role: 'owner',
          },
        });
        return { tenant, user };
      });
      return this.issue(user, tenant);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Email already registered');
      }
      throw err;
    }
  }

  async login(
    input: LoginRequest,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const user = await this.prisma.appUser.findUnique({
      where: { email: input.email },
      include: { tenant: true },
    });
    // Same error whether the email or the password is wrong — don't leak which.
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.issue(user, user.tenant);
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
    const user = await this.prisma.appUser.findUnique({
      where: { id: payload.sub },
      include: { tenant: true },
    });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    return this.issue(user, user.tenant);
  }

  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.appUser.findUniqueOrThrow({
      where: { id: userId },
      include: { tenant: true },
    });
    return {
      user: this.toUserDto(user),
      tenant: { id: user.tenant.id, name: user.tenant.name },
    };
  }

  private async issue(
    user: AppUser,
    tenant: Tenant,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, tenantId: tenant.id, role: user.role },
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
        tenant: { id: tenant.id, name: tenant.name },
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
