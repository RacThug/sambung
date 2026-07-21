import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  listSyncConflictsQuerySchema,
  type DismissSyncConflictResponse,
  type ListSyncConflictsQuery,
  type SyncConflict,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SyncConflictsService } from './sync-conflicts.service';

/**
 * The sync-conflict inbox - `/sync-conflicts` (#38, api-spec §7.5). Where an OTA
 * double-sold nights Sambung already holds, so the exclusion constraint refused the
 * import and the pipeline filed it here for a human (ADR-0025, ADR-0027).
 *
 * Authed and owner-only, unlike most of this module (the export feed is public, the
 * import cron has no principal): the guard mints the UserPrincipal and seeds the
 * TenantContext, so both routes run on the owner RLS connection. HTTP only - the
 * scoping and the derived blocking-booking join live in the service/repository.
 */
@Controller('sync-conflicts')
@UseGuards(JwtAuthGuard)
export class SyncConflictsController {
  constructor(private readonly service: SyncConflictsService) {}

  // The inbox list. `status` defaults to `open` in the schema, so a bare
  // `GET /sync-conflicts` is the inbox rather than the archive.
  @Get()
  list(
    @Query(new ZodValidationPipe(listSyncConflictsQuerySchema))
    query: ListSyncConflictsQuery,
  ): Promise<SyncConflict[]> {
    return this.service.list(query);
  }

  // Dismiss one - a verb-subresource like /bookings/:id/cancel and
  // /payments/:id/handle. Idempotent: dismissing twice returns the same 200.
  // Unknown / cross-tenant id → 404. There is NO matching `resolve` route (§7.5).
  @Post(':id/dismiss')
  @HttpCode(200)
  dismiss(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DismissSyncConflictResponse> {
    return this.service.dismiss(id);
  }
}
