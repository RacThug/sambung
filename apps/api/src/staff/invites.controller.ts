import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  acceptInviteRequestSchema,
  createInviteRequestSchema,
  inviteTokenSchema,
  type AcceptInviteRequest,
  type AuthResponse,
  type CreateInviteRequest,
  type InviteDto,
  type InvitePreviewResponse,
  type ListInvitesResponse,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { setRefreshCookie } from '../auth/refresh-cookie';
import { Roles } from '../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RolesGuard } from '../common/roles.guard';
import { ThrottleSensitive } from '../common/throttle/throttle.decorator';
import { InvitesService } from './invites.service';

/**
 * Staff invites (#57, api-spec §3.6, FR-AUTH-2).
 *
 * The one controller in the codebase that mixes guarded and unguarded routes on
 * purpose, and the split is the design: managing invites is the owner's, holding
 * one is the invitee's. `@UseGuards` therefore sits on the three management
 * handlers rather than on the class - the two accept routes have no session to
 * guard, because their whole purpose is to create the first one.
 *
 * Under `/auth` because that is where the API keeps session-minting routes, and
 * an accepted invite mints a session exactly as login does.
 */
@Controller('auth/invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner')
  create(
    @Body(new ZodValidationPipe(createInviteRequestSchema))
    dto: CreateInviteRequest,
  ): Promise<InviteDto> {
    return this.invites.create(dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner')
  async list(): Promise<ListInvitesResponse> {
    return { invites: await this.invites.listPending() };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner')
  @HttpCode(204)
  revoke(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.invites.revoke(id);
  }

  /**
   * What the `/invite/:token` page renders before asking for a password.
   *
   * UNAUTHENTICATED, and that is the correct reading of "authentication": the
   * token is 256 bits of CSPRNG output, so presenting it IS the credential. A
   * session requirement here would be circular - the caller is about to get
   * their first account.
   *
   * Nested under `token/` rather than sitting at `:token`, so it can never be
   * confused with the uuid-shaped `:id` the revoke route takes.
   *
   * Bounded and throttled exactly like `accept` below, because it is the same
   * surface: one unauthenticated route taking one unauthenticated secret. Two
   * protections on one of them and none on the other is not a decision, it is an
   * oversight - the boundary rule (CLAUDE.md: validate all external input with
   * zod) does not stop at request bodies.
   */
  @ThrottleSensitive()
  @Get('token/:token')
  preview(
    @Param('token', new ZodValidationPipe(inviteTokenSchema)) token: string,
  ): Promise<InvitePreviewResponse> {
    return this.invites.preview(token);
  }

  /**
   * Accept: create the staff account and start its session.
   *
   * `@ThrottleSensitive` for the same reason register and login carry it
   * (ADR-0014): this is an unauthenticated route that creates credentials. The
   * token is not realistically guessable, so the tight limit is not what
   * protects it - it is what stops the endpoint being a free bcrypt oracle at 12
   * rounds a request.
   */
  @ThrottleSensitive()
  @Post('accept')
  @HttpCode(200)
  async accept(
    @Body(new ZodValidationPipe(acceptInviteRequestSchema))
    dto: AcceptInviteRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const { auth, refreshToken } = await this.invites.accept(dto);
    setRefreshCookie(res, refreshToken);
    return auth;
  }
}
