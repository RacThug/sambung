import { Injectable, NotFoundException } from '@nestjs/common';
import {
  publicPropertyResponseSchema,
  toRupiah,
  type PublicPropertyResponse,
} from '@sambung/shared';
import { PublicScope } from '../common/public-scope.service';
import { StorageService } from '../storage/storage.service';
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
}
