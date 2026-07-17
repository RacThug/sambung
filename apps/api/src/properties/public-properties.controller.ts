import { Controller, Get, Param } from '@nestjs/common';
import type { PublicPropertyResponse } from '@sambung/shared';
import { PublicPropertiesService } from './public-properties.service';

/**
 * The public property page (api-spec §4.7, page-spec §3.1) - the first
 * unauthenticated route in the API.
 *
 * No JwtAuthGuard, on purpose: a Visitor has no token. The tenant scope comes
 * from the slug instead (PublicScope, ADR-0003), and it is the SERVICE that
 * enters it - so this controller stays what every controller here is: HTTP only.
 *
 * No ParseUUIDPipe on the param either. A slug is not a UUID; it is free text
 * from a URL bar, and it reaches the database only as a parameterized `where
 * slug = $1`. An unknown or malformed one is simply a 404.
 */
@Controller('public/properties')
export class PublicPropertiesController {
  constructor(private readonly properties: PublicPropertiesService) {}

  @Get(':slug')
  getBySlug(@Param('slug') slug: string): Promise<PublicPropertyResponse> {
    return this.properties.getBySlug(slug);
  }
}
