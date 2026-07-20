import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildPropertyOgTags,
  publicPropertyResponseSchema,
  toRupiah,
  type PublicPropertyResponse,
} from '@sambung/shared';
import { PublicScope } from '../common/public-scope.service';
import { StorageService } from '../storage/storage.service';
import { ogCanonicalUrl, renderPropertyOgHtml } from './property-og-html';
import { PropertiesRepository } from './properties.repository';

/**
 * The public property page (api-spec §4.7, FR-PROP-1/3, #46).
 *
 * The only difference from PropertiesService is how the tenant is established:
 * there, JwtAuthGuard minted a principal from a token before the service ran;
 * here, enterFromSlug mints one from the slug. After that line, everything below
 * is an ordinary tenant-scoped read - same RLS, same WHERE, same repository.
 */
@Injectable()
export class PublicPropertiesService {
  constructor(
    private readonly scope: PublicScope,
    private readonly repo: PropertiesRepository,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  async getBySlug(slug: string): Promise<PublicPropertyResponse> {
    // Establish who we act for BEFORE touching anything tenant-scoped. Every
    // query after this line runs under that tenant's RLS scope; without it,
    // TenantDbService.run throws rather than guessing.
    await this.scope.enterFromSlug(slug);

    const row = await this.repo.findPublicBySlug(slug);
    if (!row) {
      throw new NotFoundException('Property not found');
    }

    // NOT gated on `publishable` (ADR-0004). A property with no photos renders
    // without a gallery; one with no priced unit renders without a price. The
    // Owner's dashboard has been telling them so all along - but a public URL
    // must not blink out of existence because someone deleted a photo.
    //
    // Parsed on the way OUT, which is unusual and deliberate. The object below
    // is built field by field, so today the parse can only pass. It is here for
    // the day someone "simplifies" this into `{ ...row }`: zod strips unknown
    // keys, so the payload cannot silently widen to whatever the row grew. One
    // line that makes "no PII in the public payload" a property of the code
    // rather than a promise in a review.
    return publicPropertyResponseSchema.parse({
      slug: row.slug,
      name: row.name,
      address: row.address,
      description: row.description,
      verified: row.verified,
      depositPct: row.depositPct,
      photos: row.photos.map((key) => ({ url: this.storage.publicUrl(key) })),
      units: row.units.map((u) => ({
        id: u.id,
        name: u.name,
        basePriceIdr: toRupiah(u.basePriceIdr),
        maxGuests: u.maxGuests,
        minStay: u.minStay,
      })),
    });
  }

  /**
   * The static OG stub for link-preview crawlers (architecture §6 tier 2, #87,
   * ADR-0019). NOT a second read path: it goes through `getBySlug`, so the tenant
   * scope (enterFromSlug + RLS), the archived→404 (ADR-0006), and the malformed-
   * slug→404 (SlugParamPipe) are the SAME ones the JSON page has - a crawler
   * cannot see a property a Visitor cannot.
   *
   * The values come from the SHARED `buildPropertyOgTags`, the exact helper the
   * SPA's <meta> tags use, then `renderPropertyOgHtml` escapes them into a static
   * document. `canonicalUrl` is the human page (`/p/:slug`) this stands in for -
   * derived from TRUSTED CONFIG (`WEB_BASE_URL`) rather than the inbound `Host`,
   * which is client-settable (#127); `requestOrigin` is only a dev/direct-hit
   * fallback when no public base is configured.
   */
  async getOgHtmlBySlug(slug: string, requestOrigin: string): Promise<string> {
    const property = await this.getBySlug(slug);
    const canonicalUrl = ogCanonicalUrl({
      configuredBase: this.config.get<string>('WEB_BASE_URL'),
      requestOrigin,
      slug,
    });
    return renderPropertyOgHtml({
      tags: buildPropertyOgTags(property),
      canonicalUrl,
    });
  }
}
