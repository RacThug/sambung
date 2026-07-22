import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  createChannelConnectionRequestSchema,
  type ChannelConnectionResponse,
  type CreateChannelConnectionRequest,
  type DisconnectChannelResponse,
  type SyncConnectionResponse,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { NoBody } from '../common/decorators/no-body.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ChannelsService } from './channels.service';

/**
 * Channels nested under their unit (api-spec §7.1/7.2, #28/#29). Two controllers,
 * one module, like units: connecting and listing are questions about a unit ("what
 * feeds does it have?", "add one"), while disconnecting addresses a connection
 * directly by its own id (§7.4, #30). The guard seeds TenantContext, so every
 * service call runs on the owner RLS connection and scopes by tenant_id.
 */
@Controller('units/:unitId/channels')
@UseGuards(JwtAuthGuard)
export class UnitChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  list(
    @Param('unitId', ParseUUIDPipe) unitId: string,
  ): Promise<ChannelConnectionResponse[]> {
    return this.channels.list(unitId);
  }

  @Post()
  connect(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body(new ZodValidationPipe(createChannelConnectionRequestSchema))
    dto: CreateChannelConnectionRequest,
  ): Promise<ChannelConnectionResponse> {
    return this.channels.connect(unitId, dto);
  }
}

/** A connection addressed directly (api-spec §7.4, #30). */
@Controller('channels')
@UseGuards(JwtAuthGuard)
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  // 200 (not 204): disconnect RETURNS how many imported bookings were kept, so the
  // owner can clean up deliberately (api-spec §7.4). Unknown / foreign id → 404.
  @Delete(':id')
  @HttpCode(200)
  @NoBody()
  disconnect(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DisconnectChannelResponse> {
    return this.channels.disconnect(id);
  }

  // "Sync now" (api-spec §7.3, #31/#56): force this connection's import off the
  // 30-min cron. 200 with the post-sync health + a summary (not 202 queued - the
  // pull runs synchronously; there is no queue on a single VPS, ADR-0025).
  // Unknown / foreign id → 404.
  @Post(':id/sync')
  @HttpCode(200)
  @NoBody()
  syncNow(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SyncConnectionResponse> {
    return this.channels.syncNow(id);
  }
}
