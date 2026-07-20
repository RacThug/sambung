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
   * URL is the HUMAN page (`/p/:slug`) this stub represents, built here from the
   * request host because it is not a property fact; the slug is already
   * SLUG_PATTERN-validated by the pipe, so it is safe in a URL path.
   */
  @Get(':slug/og')
  @Header('Content-Type', 'text/html; charset=utf-8')
  getOg(
    @Param('slug', SlugParamPipe) slug: string,
    @Req() req: Request,
  ): Promise<string> {
    // `req.protocol`/`req.hostname` honour X-Forwarded-* only when TRUST_PROXY is
    // set (main.ts) - i.e. behind Caddy in prod, which is the only place this
    // route is reached. `req.get('host')` keeps the port for a dev/direct hit.
    const host = req.get('host') ?? 'localhost';
    const canonicalUrl = `${req.protocol}://${host}/p/${slug}`;
    return this.properties.getOgHtmlBySlug(slug, canonicalUrl);
  }
}
