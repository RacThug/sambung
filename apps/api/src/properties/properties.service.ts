import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  isPublishable,
  isVerified,
  propertyTimeZoneSchema,
  slugCandidates,
  type CreatePropertyRequest,
  type PresignPhotoRequest,
  type PresignPhotoResponse,
  type PropertyResponse,
  type UpdatePhotosRequest,
  type UpdatePropertyRequest,
} from '@sambung/shared';
import { propertyHasBookings } from '../common/db-error/conflicts';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';
import { StorageService } from '../storage/storage.service';
import {
  PropertiesRepository,
  type PropertyRow,
} from './properties.repository';

@Injectable()
export class PropertiesService {
  constructor(
    private readonly repo: PropertiesRepository,
    private readonly tenant: TenantContext,
    private readonly storage: StorageService,
    private readonly db: TenantDbService,
  ) {}

  async list(): Promise<PropertyResponse[]> {
    const rows = await this.repo.findAll();
    return rows.map((row) => this.toResponse(row));
  }

  async get(id: string): Promise<PropertyResponse> {
    return this.toResponse(await this.getOwnedOrThrow(id));
  }

  /**
   * Create, minting the public slug from the name (ADR-0004).
   *
   * The loop IS the uniqueness check. There is no pre-check, and there cannot
   * be one: the slug is globally unique, so the rows we would collide with
   * belong to other tenants - which RLS hides from us. "Is this slug free?"
   * would always answer yes and then lose at the index. So we ask the index
   * directly, by trying to insert, and try the next candidate if it says no.
   *
   * A collision is never the owner's problem to solve. They typed a NAME; the
   * slug is ours to derive. Surfacing a 409 would ask them to fix a word they
   * never wrote - and would confirm that some other tenant holds it, which is
   * the cross-tenant existence oracle api-spec §1 forbids.
   *
   * One transaction for the whole loop: DO NOTHING doesn't raise, so a rejected
   * candidate leaves the transaction healthy for the next attempt.
   */
  async create(dto: CreatePropertyRequest): Promise<PropertyResponse> {
    return this.db.run(async () => {
      for (const slug of slugCandidates(dto.name)) {
        const row = await this.repo.createWithSlug({ ...dto, slug });
        if (row) return this.toResponse(row);
      }
      // Unreachable short of a bug: after the bare slug, every candidate carries
      // a fresh 5-char token out of ~17M. Exhausting them means the generator
      // stopped being random, so it must not look like a routine conflict.
      throw new InternalServerErrorException(
        'Could not mint a unique slug for this property',
      );
    });
  }

  async update(
    id: string,
    dto: UpdatePropertyRequest,
  ): Promise<PropertyResponse> {
    // PATCH semantics: absent = leave alone. Strip undefined so an omitted
    // field can never overwrite a column, and short-circuit an empty patch
    // (Drizzle rejects an empty SET; the 404 behavior must hold regardless).
    const patch = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(patch).length === 0) {
      return this.get(id);
    }
    const row = await this.repo.update(id, patch);
    if (!row) {
      throw new NotFoundException('Property not found');
    }
    return this.toResponse(row);
  }

  /**
   * Presign a photo upload (api-spec §4.5). Ownership is validated here -
   * presigning is the moment credentials-by-proxy are handed out, so a 404
   * for a foreign property must happen before any URL is signed. Nothing is
   * persisted: the key only enters the gallery via updatePhotos.
   */
  async presignPhoto(
    id: string,
    dto: PresignPhotoRequest,
  ): Promise<PresignPhotoResponse> {
    await this.getOwnedOrThrow(id);
    return this.storage.presignPhotoUpload({
      tenantId: this.tenant.tenantId,
      propertyId: id,
      contentType: dto.contentType,
      size: dto.size,
    });
  }

  /**
   * Whole-set photo update: persist + reorder + delete in one idempotent
   * operation (api-spec §4.5). Every key must carry this property's
   * `<tenantId>/<propertyId>/` prefix - a key minted for another tenant OR
   * another of the caller's own properties is rejected, so galleries can
   * never reference objects they don't own.
   *
   * Deliberately NOT wrapped in `db.run`, despite being check-then-write: the
   * storage round-trips below are network calls to Garage/R2. Holding a
   * transaction (and its row locks) open across them would tie up a pool
   * connection for the latency of an external service. The write is a single
   * statement and the exclusion of bad keys is enforced before it, so the
   * check-then-write gap costs at worst a wasted PATCH, never a bad row.
   */
  async updatePhotos(
    id: string,
    dto: UpdatePhotosRequest,
  ): Promise<PropertyResponse> {
    // Existence first: a foreign property must 404 regardless of the body.
    const existing = await this.getOwnedOrThrow(id);
    const prefix = this.storage.photoKeyPrefix(this.tenant.tenantId, id);
    if (dto.keys.some((key) => !key.startsWith(prefix))) {
      throw new BadRequestException(
        'Every photo key must belong to this property',
      );
    }
    // Keys NEW to the gallery must reference a real uploaded image (exists +
    // magic bytes) - presign alone mints a key, it doesn't earn a slot here.
    // Keys already persisted were verified when first added; reorders are free.
    const known = new Set(existing.photos);
    const rejected = (
      await Promise.all(
        dto.keys
          .filter((key) => !known.has(key))
          .map(async (key) => ({
            key,
            ok: await this.storage.isValidPhotoObject(key),
          })),
      )
    ).filter((r) => !r.ok);
    if (rejected.length > 0) {
      throw new BadRequestException(
        `Not an uploaded image: ${rejected.map((r) => r.key).join(', ')}`,
      );
    }
    const row = await this.repo.update(id, { photos: dto.keys });
    if (!row) {
      throw new NotFoundException('Property not found');
    }
    return this.toResponse(row);
  }

  /**
   * Guarded delete (api-spec §4.4, ADR-0002). Refuses when ANY booking has ever
   * referenced a unit under this property - past and cancelled included -
   * because deleting it would cascade away their payment rows too. Delete is for
   * a property that was never booked; retiring one with history is archive
   * (#84).
   *
   * The whole guard is ONE unit of work: the locks taken by lockForDelete only
   * hold for the transaction they were taken in, so counting and deleting must
   * join that same transaction or the guard is decorative. `db.run` here is what
   * makes the three repository calls below share it.
   */
  async remove(id: string): Promise<void> {
    await this.db.run(async () => {
      if (!(await this.repo.lockForDelete(id))) {
        throw new NotFoundException('Property not found');
      }
      const n = await this.repo.countBookings(id);
      if (n > 0) {
        // No "cancel them first" (cancelling doesn't remove the row): archive
        // retires it while keeping the record (ADR-0005, #84). The count rides as
        // data, not prose - the web owns the copy and composes it (#82, ADR-0012).
        throw propertyHasBookings(n);
      }
      await this.repo.delete(id);
    });
  }

  /**
   * Archive / unarchive a property (ADR-0005, #84). Idempotent - re-archiving is a
   * no-op that keeps the original `archivedAt`, unarchiving something active does
   * nothing. Archiving hides the property from guests (its public page 404s,
   * ADR-0006) and archives its Units by derivation; the owner still sees it here.
   * Re-fetches via `get` so the response carries the recomputed `publishable`.
   */
  archive(id: string): Promise<PropertyResponse> {
    return this.setArchived(id, true);
  }

  unarchive(id: string): Promise<PropertyResponse> {
    return this.setArchived(id, false);
  }

  private async setArchived(
    id: string,
    archived: boolean,
  ): Promise<PropertyResponse> {
    if (!(await this.repo.setArchived(id, archived))) {
      throw new NotFoundException('Property not found');
    }
    return this.get(id);
  }

  /**
   * Tenant-scoped fetch; 404 (not 403) when the id is unknown OR belongs to
   * another tenant - existence is hidden. (api-spec §1 tenancy)
   */
  private async getOwnedOrThrow(id: string): Promise<PropertyRow> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException('Property not found');
    }
    return row;
  }

  private toResponse(row: PropertyRow): PropertyResponse {
    const { pricedUnitCount, createdAt, photos, archivedAt, ...columns } = row;
    return {
      ...columns,
      // The column is `text` guarded by property_time_zone_known, so narrowing to
      // the closed set here is the same boundary parse channels.service does. A
      // value outside it means the CHECK was bypassed - a bug, so 500 loudly
      // rather than widen the contract to absorb it.
      timeZone: propertyTimeZoneSchema.parse(columns.timeZone),
      photos: photos.map((key) => ({
        key,
        url: this.storage.publicUrl(key),
      })),
      verified: isVerified(row.licenseNo),
      publishable: isPublishable({
        photoCount: photos.length,
        pricedUnitCount,
      }),
      // Owner-facing: the timestamp of retirement, or null if active (ADR-0005).
      archivedAt: archivedAt ? archivedAt.toISOString() : null,
      createdAt: createdAt.toISOString(),
    };
  }
}
