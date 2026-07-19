import { Controller, Get, Header, Param, ParseUUIDPipe } from '@nestjs/common';
import { IcalExportService } from './ical-export.service';

/**
 * The public `.ics` export feed (api-spec §7.6, page-spec has no page - machines
 * consume it). Unauthenticated: no JwtAuthGuard. The tenant scope comes from the
 * unit id (PublicScope.enterFromUnitId, entered by the SERVICE), so this
 * controller stays HTTP only. ParseUUIDPipe rejects a malformed unit id as a 400
 * before any lookup.
 *
 * `@Header` makes Nest send the returned string as `text/calendar` rather than
 * JSON; `inline` so a browser previews it (an owner checking the link) while an
 * OTA just subscribes to the URL.
 */
@Controller('public/units')
export class PublicChannelsController {
  constructor(private readonly export_: IcalExportService) {}

  @Get(':id/calendar.ics')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  @Header('Content-Disposition', 'inline; filename="calendar.ics"')
  calendar(@Param('id', ParseUUIDPipe) id: string): Promise<string> {
    return this.export_.exportCalendar(id);
  }
}
