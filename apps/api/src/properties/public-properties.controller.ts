import { Controller, Get, Header, Param, Req } from '@nestjs/common';
import type { PublicPropertyResponse } from '@sambung/shared';
import type { Request } from 'express';
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

  /**
   * The static OG stub for link-preview crawlers (architecture §6 tier 2, #87,
   * ADR-0019). Caddy matches a NARROW allowlist of crawler user agents on `/p/*`
   * and proxies them here; humans and Googlebot never match and get the SPA. The
   * UA match lives in `deploy/Caddyfile`, not the API - a crawler is identified
   * at the edge, and the API just renders the stub for whatever reaches it.
   *
   * `@Header` makes Nest send the returned string as `text/html`. The canonical
   * URL the stub advertises is derived in the service from TRUSTED CONFIG
   * (`WEB_BASE_URL`, the real public origin), NOT from these request headers -
   * `Host` is client-settable and `req.protocol` is `http` unless TRUST_PROXY is
   * set (#127). We still pass a request-derived origin, but only as a fallback the
   * service uses when no public base is configured (a dev/direct hit).
   */
  @Get(':slug/og')
  @Header('Content-Type', 'text/html; charset=utf-8')
  getOg(
    @Param('slug', SlugParamPipe) slug: string,
    @Req() req: Request,
  ): Promise<string> {
    const requestOrigin = `${req.protocol}://${req.get('host') ?? 'localhost'}`;
    return this.properties.getOgHtmlBySlug(slug, requestOrigin);
  }
}
