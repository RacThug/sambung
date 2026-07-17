import { Controller, Get, Param } from '@nestjs/common';
import type { PublicPropertyResponse } from '@sambung/shared';
import { SlugParamPipe } from '../common/pipes/slug-param.pipe';
import { PublicPropertiesService } from './public-properties.service';

/**
 * The public property page (api-spec §4.7, page-spec §3.1) - the first
 * unauthenticated route in the API.
 *
 * No JwtAuthGuard, on purpose: a Visitor has no token. The tenant scope comes
 * from the slug instead (PublicScope, ADR-0003), and it is the SERVICE that
 * enters it - so this controller stays what every controller here is: HTTP only.
 *
 * Not ParseUUIDPipe on the param - a slug is not a UUID - but a pipe all the
 * same. This route used to take the slug raw, on the reasoning that it reaches
 * the database only as a parameterized `where slug = $1` so a malformed one is
 * "simply a 404". Parameterizing stops injection; it does not stop `%00`, which
 * arrives as a NUL byte and comes back as an unmapped 22021, i.e. a 500 - on
 * the one route with nothing in front of it. See SlugParamPipe.
 */
@Controller('public/properties')
export class PublicPropertiesController {
  constructor(private readonly properties: PublicPropertiesService) {}

  @Get(':slug')
  getBySlug(
    @Param('slug', SlugParamPipe) slug: string,
  ): Promise<PublicPropertyResponse> {
    return this.properties.getBySlug(slug);
  }
}
