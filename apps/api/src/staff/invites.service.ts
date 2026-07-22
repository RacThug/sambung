import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import type {
  AcceptInviteRequest,
  AuthResponse,
  CreateInviteRequest,
  InviteDto,
  InvitePreviewResponse,
} from '@sambung/shared';
import { AuthService } from '../auth/auth.service';
import { TenantContext } from '../common/tenant-context.service';
import {
  emailTaken,
  inviteAlreadyPending,
  inviteNotAcceptable,
} from '../common/db-error/conflicts';
import { MAILER, type Mailer } from '../notifications/mailer';
import { InviteAcceptRepository } from './invite-accept.repository';
import { refusalReason } from './invite-liveness';
import { renderInviteEmail } from './invite-email';
import {
  hashInviteToken,
  INVITE_TTL_DAYS,
  inviteAcceptUrl,
  mintInviteToken,
} from './invite-token';
import { StaffRepository } from './staff.repository';

const BCRYPT_ROUNDS = 12;

/**
 * Staff invites (#57, FR-AUTH-2, api-spec §3.6, ADR-0033).
 *
 * Two audiences meet in this one service, which is why it depends on two
 * repositories rather than one: the owner's side runs under RLS
 * (`StaffRepository`), and the invitee's side has no principal at all and runs
 * on the owner connection (`InviteAcceptRepository`).
 */
@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(
    private readonly repo: StaffRepository,
    private readonly accepts: InviteAcceptRepository,
    private readonly auth: AuthService,
    private readonly tenant: TenantContext,
    private readonly config: ConfigService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async create(dto: CreateInviteRequest): Promise<InviteDto> {
    const principal = this.tenant.principal;
    /* istanbul ignore next - RolesGuard has already refused a non-user. */
    if (!principal || principal.kind !== 'user') {
      throw new NotFoundException('Invite not found');
    }

    // Deduplicate the ids before anything counts them, so `['a','a']` cannot
    // read as two properties and 404 against a count of one.
    const propertyIds = [...new Set(dto.propertyIds)];

    // Purely for the answer: a property this tenant cannot see is a 404, the
    // same as asking for it directly. Correctness belongs to
    // staff_invite_property's composite FK, which makes a cross-tenant grant
    // unrepresentable no matter what this check does.
    const visible = await this.repo.countVisibleProperties(propertyIds);
    if (visible !== propertyIds.length) {
      throw new NotFoundException('Property not found');
    }

    // GLOBAL, not tenant-scoped, because `app_user_email_key` is global. Asking
    // only about our own tenant (as this did) let an invite be created and
    // EMAILED to someone who already had an account elsewhere - and it then
    // answered 409 on every attempt to accept, forever, with nothing to tell
    // either party why. Found in review; the test names the shape.
    //
    // The same 409 either way (§5.3): the pre-check and the constraint at accept
    // are indistinguishable, this one merely arrives before the email does.
    if (await this.accepts.emailHasAccountAnywhere(dto.email)) {
      throw emailTaken();
    }

    // An invite that has simply run out of time must not stand in the way of its
    // own replacement. The partial unique index cannot test expiry (an index
    // predicate must be immutable), so the stale row is closed here first -
    // otherwise re-inviting the same address is refused forever.
    await this.repo.supersedeExpiredInvites(dto.email);

    // The friendly half of a two-layer check; staff_invite_live_email_uniq is
    // the guarantee, and a racing create lands on the identical 409 (§5.3).
    if (await this.repo.hasLiveInvite(dto.email)) throw inviteAlreadyPending();

    const token = mintInviteToken();
    const expiresAt = new Date(
      Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    const inviteId = await this.repo.createInvite({
      email: dto.email,
      tokenHash: hashInviteToken(token),
      expiresAt,
      createdBy: principal.userId,
      propertyIds,
    });

    // The invite exists but is USELESS until this email lands - the token is not
    // recoverable from anywhere else, by design. So unlike the confirmation
    // email (best-effort, because the booking is already real), a failure here
    // is failure of the whole operation.
    //
    // And it must UNDO the row, not merely report: `staff_invite_live_email_uniq`
    // would otherwise leave a pending-but-unreachable invite blocking every
    // retry for this address, and the owner has no way to see why.
    try {
      // Read the invite back through the accept-side view: it already joins the
      // tenant name, the inviter's email and the granted property names, which
      // is exactly the email's payload. Reusing it beats assembling the same
      // three facts a second way, one read instead of three.
      const view = await this.accepts.findByTokenHash(hashInviteToken(token));
      /* istanbul ignore next - it was inserted in the transaction above. */
      if (!view) throw new Error(`invite ${inviteId} vanished after create`);
      await this.mailer.send(
        renderInviteEmail({
          to: view.email,
          tenantName: view.tenantName,
          invitedBy: view.invitedBy,
          propertyNames: view.propertyNames,
          acceptUrl: inviteAcceptUrl(this.webBaseUrl(), token),
          expiresAt,
        }),
      );
    } catch (err) {
      await this.repo.revokeInvite(inviteId).catch(() => undefined);
      this.logger.error(
        `Invite email to ${dto.email} failed; invite ${inviteId} revoked: ${String(err)}`,
      );
      throw new ServiceUnavailableException(
        'Could not send the invite email - nothing was created, please try again',
      );
    }

    const created = (await this.listPending()).find((i) => i.id === inviteId);
    /* istanbul ignore next - just created and still live. */
    if (!created) throw new NotFoundException('Invite not found');
    return created;
  }

  async listPending(): Promise<InviteDto[]> {
    const rows = await this.repo.listPendingInvites();
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      // Non-null for an invite - the column is NOT NULL. The shared row type is
      // widened only because it is reused by the staff list, which has no expiry.
      expiresAt: (row.expiresAt ?? new Date()).toISOString(),
      createdAt: row.createdAt.toISOString(),
      properties: row.properties,
    }));
  }

  async revoke(inviteId: string): Promise<void> {
    const found = await this.repo.revokeInvite(inviteId);
    if (!found) throw new NotFoundException('Invite not found');
  }

  /**
   * What `/invite/:token` shows before asking for a password.
   *
   * An unknown token is a 404 and a dead one is a 409 - the same split accept
   * uses, so a holder who reloads the page after their link expired is told the
   * same thing either way rather than watching a working page turn into a 404.
   */
  async preview(token: string): Promise<InvitePreviewResponse> {
    const invite = await this.accepts.findByTokenHash(hashInviteToken(token));
    if (!invite) throw new NotFoundException('Invite not found');
    const reason = refusalReason(invite);
    if (reason) throw inviteNotAcceptable(reason);
    return {
      email: invite.email,
      tenantName: invite.tenantName,
      propertyNames: invite.propertyNames,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /**
   * Spend an invite: create the staff account and start its session.
   *
   * Note the order - resolve, hash, THEN spend. The bcrypt cost sits outside the
   * transaction on purpose: holding a row lock for ~300 ms of CPU is how a hot
   * path becomes a queue. Two racing accepts are still safe, because the guarded
   * UPDATE inside `accept` (not this read) is what arbitrates.
   */
  async accept(
    dto: AcceptInviteRequest,
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const invite = await this.accepts.findByTokenHash(
      hashInviteToken(dto.token),
    );
    if (!invite) throw new NotFoundException('Invite not found');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const created = await this.accepts.accept({
      inviteId: invite.id,
      passwordHash,
    });
    if (!created) {
      // The UPDATE matched nothing, so the invite was not live when it counted.
      // Re-read rather than reuse the stale row above: between the two, someone
      // else may have accepted it, and the honest answer is what is true now.
      const fresh = await this.accepts.findByTokenHash(
        hashInviteToken(dto.token),
      );
      // `?? 'expired'` covers the vanishingly narrow case where the re-read says
      // the invite is live: it was not live when the guarded UPDATE looked, and
      // running out of time is the only way that happens without another closure
      // timestamp being set.
      throw inviteNotAcceptable((fresh && refusalReason(fresh)) ?? 'expired');
    }
    this.logger.log(
      `Invite ${invite.id} accepted - staff user ${created.user.id} created for tenant ${created.tenant.id}`,
    );
    return this.auth.startSessionForVerifiedUser(created.user, created.tenant);
  }

  private webBaseUrl(): string {
    return this.config.get<string>('WEB_BASE_URL') ?? 'http://localhost:5173';
  }
}
