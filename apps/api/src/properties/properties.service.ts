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
  ) {}

  async list(): Promise<PropertyResponse[]> {
    const rows = await this.repo.findAllByTenant(this.tenant.tenantId);
    return rows.map((row) => this.toResponse(row));
  }

  async get(id: string): Promise<PropertyResponse> {
    const row = await this.repo.findByIdForTenant(id, this.tenant.tenantId);
    // 404 (not 403) for another tenant's id — don't reveal that it exists.
    if (!row) {
      throw new NotFoundException('Property not found');
    }
    return this.toResponse(row);
  }

  async create(dto: CreatePropertyRequest): Promise<PropertyResponse> {
    const row = await this.repo.create({
      ...dto,
      tenantId: this.tenant.tenantId,
    });
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
    const row = await this.repo.update(id, this.tenant.tenantId, patch);
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
    const row = await this.repo.findByIdForTenant(id, this.tenant.tenantId);
    if (!row) {
      throw new NotFoundException('Property not found');
    }
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
   */
  async updatePhotos(
    id: string,
    dto: UpdatePhotosRequest,
  ): Promise<PropertyResponse> {
    // Existence first: a foreign property must 404 regardless of the body.
    const existing = await this.repo.findByIdForTenant(
      id,
      this.tenant.tenantId,
    );
    if (!existing) {
      throw new NotFoundException('Property not found');
    }
    const prefix = this.storage.photoKeyPrefix(this.tenant.tenantId, id);
    if (dto.keys.some((key) => !key.startsWith(prefix))) {
      throw new BadRequestException(
        'Every photo key must belong to this property',
      );
    }
    const row = await this.repo.update(id, this.tenant.tenantId, {
      photos: dto.keys,
    });
    if (!row) {
      throw new NotFoundException('Property not found');
    }
    return this.toResponse(row);
  }

  async remove(id: string): Promise<void> {
    const result = await this.repo.deleteWithGuard(id, this.tenant.tenantId);
    if (!result.found) {
      throw new NotFoundException('Property not found');
    }
    if (!result.deleted) {
      const n = result.futureBookings;
      // Deleting live inventory must be an explicit two-step (api-spec §4.4):
      // the count tells the owner exactly what to cancel first.
      throw new ConflictException(
        `Cannot delete: ${n} future booking${n === 1 ? '' : 's'} - cancel them first`,
      );
    }
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
