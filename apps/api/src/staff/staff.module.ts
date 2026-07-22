import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InviteAcceptRepository } from './invite-accept.repository';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { StaffController } from './staff.controller';
import { StaffRepository } from './staff.repository';
import { StaffService } from './staff.service';

/**
 * Staff invites + the Team roster (#57, FR-AUTH-2).
 *
 * Property-scoped RBAC itself is NOT here, and that is worth stating: staff
 * scoping is enforced by RLS (ADR-0032), established once in TenantDbService.
 * This module owns who the staff are and what they are assigned - the rows the
 * policies read - not the enforcement.
 *
 * Imports AuthModule for JwtAuthGuard AND for AuthService, which mints the
 * session an accepted invite lands in; NotificationsModule for the MAILER port
 * the invite email goes out through (LogMailer unless Resend is configured -
 * ADR-0021, so no test or unconfigured deploy reaches a live provider).
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [InvitesController, StaffController],
  providers: [
    InvitesService,
    StaffService,
    StaffRepository,
    InviteAcceptRepository,
  ],
})
export class StaffModule {}
