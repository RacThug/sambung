import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isPublishable,
  isVerified,
  type CreatePropertyRequest,
  type PresignPhotoRequest,
  type PresignPhotoResponse,
  type PropertyResponse,
  type UpdatePhotosRequest,
  type UpdatePropertyRequest,
} from '@sambung/shared';
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

  async create(dto: CreatePropertyRequest): Promise<PropertyResponse> {
    const row = await this.repo.create(dto);
    return this.toResponse(row);
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
        // No "cancel them first": cancelling doesn't remove the row, so it would
        // promise an escape that doesn't exist. Says why instead.
        throw new ConflictException(
          `Cannot delete: this property has ${n} booking${n === 1 ? '' : 's'} - deleting it would destroy that history`,
        );
      }
      await this.repo.delete(id);
    });
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
    const { pricedUnitCount, createdAt, photos, ...columns } = row;
    return {
      ...columns,
      photos: photos.map((key) => ({
        key,
        url: this.storage.publicUrl(key),
      })),
      verified: isVerified(row.licenseNo),
      publishable: isPublishable({
        photoCount: photos.length,
        pricedUnitCount,
      }),
      createdAt: createdAt.toISOString(),
    };
  }
}
