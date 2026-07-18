import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  toRupiah,
  type CreateUnitRequest,
  type UnitResponse,
  type UpdateUnitRequest,
} from '@sambung/shared';
import type { Unit } from '@sambung/db';
import { TenantDbService } from '../db/tenant-db.service';
import { UnitsRepository } from './units.repository';

@Injectable()
export class UnitsService {
  constructor(
    private readonly repo: UnitsRepository,
    private readonly db: TenantDbService,
  ) {}

  async listByProperty(propertyId: string): Promise<UnitResponse[]> {
    await this.assertPropertyOwned(propertyId);
    const rows = await this.repo.findByProperty(propertyId);
    return rows.map((row) => this.toResponse(row));
  }

  async create(
    propertyId: string,
    dto: CreateUnitRequest,
  ): Promise<UnitResponse> {
    // Purely for the 404. Correctness is already the DB's: unit.tenant_id comes
    // from TenantContext, and unit_property_tenant_fk (#40) requires
    // (property_id, tenant_id) to match a real property row - so a unit under
    // someone else's property is unrepresentable, with or without this check.
    // Without it that arrives as 23503 -> unmapped -> 500 instead of a 404, which
    // is the difference between "app checks are for UX" and "for correctness".
    await this.assertPropertyOwned(propertyId);
    const row = await this.repo.create({
      propertyId,
      name: dto.name,
      basePriceIdr: BigInt(dto.basePriceIdr),
      maxGuests: dto.maxGuests,
      minStay: dto.minStay,
    });
    return this.toResponse(row);
  }

  async update(id: string, dto: UpdateUnitRequest): Promise<UnitResponse> {
    // PATCH semantics: absent = leave alone. Built field by field rather than by
    // stripping undefined generically, because basePriceIdr changes type on the
    // way through - a JSON number on the wire, a bigint in the column.
    const patch: Partial<Omit<Unit, 'id' | 'tenantId' | 'propertyId'>> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.basePriceIdr !== undefined) {
      patch.basePriceIdr = BigInt(dto.basePriceIdr);
    }
    if (dto.maxGuests !== undefined) patch.maxGuests = dto.maxGuests;
    if (dto.minStay !== undefined) patch.minStay = dto.minStay;

    // Drizzle rejects an empty SET, and the 404 must hold regardless of body.
    if (Object.keys(patch).length === 0) {
      return this.toResponse(await this.getOwnedOrThrow(id));
    }
    const row = await this.repo.update(id, patch);
    if (!row) {
      throw new NotFoundException('Unit not found');
    }
    return this.toResponse(row);
  }

  /**
   * Guarded delete (ADR-0002). Refuses when ANY booking has ever referenced this
   * unit - past and cancelled included - because deleting it would cascade away
   * their payment rows too. Delete is for a unit that was never booked; retiring
   * one with history is archive (#84).
   *
   * The whole guard is ONE unit of work: the lock from lockForDelete only holds
   * for the transaction it was taken in, so counting and deleting must join that
   * same transaction or the guard is decorative. `db.run` here is what makes the
   * three repository calls below share it.
   *
   * The FKs refuse this too (0003), which is the layer that actually guarantees
   * it. They stay unmapped in db-error.map.ts on purpose: the lock means no
   * booking can appear between the count and the delete, so if a FK ever does
   * fire it means something deleted a unit without coming through here - a bug,
   * and it should read as a 500 rather than be dressed up as a tidy 409.
   */
  async remove(id: string): Promise<void> {
    await this.db.run(async () => {
      if (!(await this.repo.lockForDelete(id))) {
        throw new NotFoundException('Unit not found');
      }
      const n = await this.repo.countBookings(id);
      if (n > 0) {
        // No "cancel them first" (cancelling doesn't remove the row), but there is
        // now an exit: archive retires it while keeping the record (ADR-0005, #84).
        throw new ConflictException(
          `Cannot delete: this unit has ${n} booking${n === 1 ? '' : 's'} - deleting it would destroy that history. Archive it instead to retire it while keeping the record.`,
        );
      }
      await this.repo.delete(id);
    });
  }

  /**
   * Archive / unarchive a unit (ADR-0005, #84). Idempotent - re-archiving keeps
   * the original `archivedAt`, unarchiving something active does nothing. An
   * archived unit drops off the public page and out of `publishable`, but its
   * existing bookings are untouched; the owner still sees it. The repo returns the
   * updated row directly, so no re-fetch is needed.
   */
  async archive(id: string): Promise<UnitResponse> {
    return this.setArchived(id, true);
  }

  async unarchive(id: string): Promise<UnitResponse> {
    return this.setArchived(id, false);
  }

  private async setArchived(
    id: string,
    archived: boolean,
  ): Promise<UnitResponse> {
    const row = await this.repo.setArchived(id, archived);
    if (!row) {
      throw new NotFoundException('Unit not found');
    }
    return this.toResponse(row);
  }

  private async assertPropertyOwned(propertyId: string): Promise<void> {
    if (!(await this.repo.propertyExists(propertyId))) {
      throw new NotFoundException('Property not found');
    }
  }

  /**
   * Tenant-scoped fetch; 404 (not 403) when the id is unknown OR belongs to
   * another tenant - existence is hidden. (api-spec §1 tenancy)
   */
  private async getOwnedOrThrow(id: string): Promise<Unit> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException('Unit not found');
    }
    return row;
  }

  private toResponse(row: Unit): UnitResponse {
    const { basePriceIdr, createdAt, archivedAt, ...columns } = row;
    return {
      ...columns,
      // The one place a bigint column becomes a JSON number (api-spec §8.4).
      // Returning the raw BigInt would throw TypeError inside JSON.stringify.
      basePriceIdr: toRupiah(basePriceIdr),
      // Owner-facing: the timestamp of retirement, or null if active (ADR-0005).
      archivedAt: archivedAt ? archivedAt.toISOString() : null,
      createdAt: createdAt.toISOString(),
    };
  }
}
