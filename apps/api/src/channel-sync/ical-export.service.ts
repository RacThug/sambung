import { Injectable } from '@nestjs/common';
import { PublicScope } from '../common/public-scope.service';
import { ChannelsRepository } from './channels.repository';
import { buildCalendar } from './ical';

// Identifies Sambung as the feed's producer (RFC 5545 PRODID).
const PROD_ID = '-//Sambung//Availability Export//EN';

/**
 * The public `.ics` export feed (api-spec §7.6, #55, ADR-0016) - the availability
 * an owner pastes back into an OTA so it stops selling nights Sambung already sold.
 *
 * Unauthenticated: an OTA's calendar subscriber has no token. The unguessable
 * unit UUID in the URL is BOTH the address and the capability - resolving the
 * tenant from it (PublicScope.enterFromUnitId, the pure resolver of ADR-0008)
 * mints a Visitor, and everything after runs under RLS as that tenant. So the feed
 * is structurally incapable of becoming a cross-tenant read path (invariant #2):
 * a bug in the query cannot reach another tenant's bookings - RLS filters them.
 *
 * Deliberately ARCHIVE-BLIND. The resolver judges nothing, and there is no
 * archived check here: an archived Unit that still has bookings MUST keep serving
 * its calendar, or the OTA that already subscribed sees those nights as free and
 * double-books (schema comment on channel_connection). Retiring a Unit hides it
 * from GUESTS (its public page, the availability quote); it does not un-tell an
 * OTA about stays that exist.
 */
@Injectable()
export class IcalExportService {
  constructor(
    private readonly scope: PublicScope,
    private readonly repo: ChannelsRepository,
  ) {}

  async exportCalendar(unitId: string): Promise<string> {
    // 404s a unit that does not exist at all; archived is NOT judged (see above).
    await this.scope.enterFromUnitId(unitId);

    const bookings = await this.repo.findConfirmedBookingsForExport(unitId);
    return buildCalendar({
      prodId: PROD_ID,
      events: bookings.map((b) => ({
        // UID = booking id (api-spec §7.6) - an opaque UUID, no PII.
        uid: b.id,
        // Half-open [check_in, check_out) → all-day DTSTART/DTEND, DTEND exclusive
        // and native (buildCalendar). No guest name / email / phone / price is
        // ever selected into these rows.
        start: b.checkIn,
        end: b.checkOut,
      })),
    });
  }
}
