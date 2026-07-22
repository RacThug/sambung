import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  loginRequestSchema,
  registerRequestSchema,
  type AuthResponse,
  type LoginRequest,
  type MeResponse,
  type RegisterRequest,
} from '@sambung/shared';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { NoBody } from '../common/decorators/no-body.decorator';
import type { UserPrincipal } from '../common/tenant-context.service';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ThrottleSensitive } from '../common/throttle/throttle.decorator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';
import {
  clearRefreshCookie,
  REFRESH_COOKIE,
  setRefreshCookie,
} from './refresh-cookie';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Signup is abuse-prone (tenant flooding) - the tighter `sensitive` throttler
  // applies on top of the global default (api-spec §8.3, #59).
  @ThrottleSensitive()
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerRequestSchema)) dto: RegisterRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const { auth, refreshToken } = await this.auth.register(dto);
    setRefreshCookie(res, refreshToken);
    return auth;
  }

  // Login is the credential-guessing surface - same tighter throttler as register
  // (api-spec §8.3, #59). Refresh/logout stay on the default limit: they carry a
  // cookie, not a guessable secret, and throttling refresh would log a user out.
  @ThrottleSensitive()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) dto: LoginRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const { auth, refreshToken } = await this.auth.login(dto);
    setRefreshCookie(res, refreshToken);
    return auth;
  }

  @Post('refresh')
  @HttpCode(200)
  @NoBody()
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    const { auth, refreshToken } = await this.auth.refresh(token);
    setRefreshCookie(res, refreshToken);
    return auth;
  }

  @Post('logout')
  @HttpCode(204)
  @NoBody()
  logout(@Res({ passthrough: true }) res: Response): void {
    clearRefreshCookie(res);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentPrincipal() principal: UserPrincipal): Promise<MeResponse> {
    return this.auth.me(principal.userId);
  }
}
