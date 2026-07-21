import { Injectable, NotFoundException } from '@nestjs/common';
import {
  PHOTO_GALLERY_CEILING,
  type TenantSettingsResponse,
  type UpdateTenantSettingsRequest,
} from '@sambung/shared';
import { SettingsRepository } from './settings.repository';

/**
 * Tenant settings (#67, ADR-0030). One knob today - the Gallery cap - and the
 * home #57 will hang Team settings on.
 *
 * The read is open to any authenticated user because the property workbench
 * needs the cap to know when a gallery is full; only the write is owner-only,
 * enforced by `@Roles('owner')` on the controller.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly repo: SettingsRepository) {}

  async get(): Promise<TenantSettingsResponse> {
    return this.toResponse(await this.galleryCap());
  }

  /**
   * Partial update. An empty body is a no-op that returns current settings
   * rather than an error: PATCH means "change what I named", and naming nothing
   * changed nothing.
   *
   * Lowering the cap below an existing gallery is deliberately ALLOWED and
   * touches no photo. The cap is enforced where a gallery grows, so an over-cap
   * gallery stays readable, reorderable and shrinkable until its owner brings it
   * down (ADR-0030). A settings screen that could silently delete photos would
   * be the ledger-mutation mistake ADR-0002 forbids, one domain over.
   */
  async update(
    dto: UpdateTenantSettingsRequest,
  ): Promise<TenantSettingsResponse> {
    if (dto.galleryCap === undefined) return this.get();
    return this.toResponse(
      this.orThrow(await this.repo.setGalleryCap(dto.galleryCap)),
    );
  }

  /**
   * The cap, for the one other reader that needs it: the photo write
   * (PropertiesService.updatePhotos). Exposed as a method rather than letting
   * properties reach for SettingsRepository, so "what is this tenant's cap?" has
   * one answer and one owner - the same reason `quote()` is the single interval
   * authority.
   */
  async galleryCap(): Promise<number> {
    return this.orThrow(await this.repo.getGalleryCap());
  }

  /**
   * The repository answers `undefined` when the row is invisible - an
   * authenticated principal whose tenant was deleted mid-session. That is a 404,
   * never the default: silently substituting 30 would answer a question about a
   * tenant that no longer exists.
   */
  private orThrow(galleryCap: number | undefined): number {
    if (galleryCap === undefined) {
      throw new NotFoundException('Tenant not found');
    }
    return galleryCap;
  }

  private toResponse(galleryCap: number): TenantSettingsResponse {
    return { galleryCap, galleryCeiling: PHOTO_GALLERY_CEILING };
  }
}
