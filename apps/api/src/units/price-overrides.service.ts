import { Injectable, NotFoundException } from '@nestjs/common';
import {
  toRupiah,
  type CreatePriceOverrideRequest,
  type PriceOverrideResponse,
} from '@sambung/shared';
import type { UnitPriceOverride } from '@sambung/db';
import { priceOverrideOverlap } from '../common/db-error/conflicts';
import { TenantDbService } from '../db/tenant-db.service';
import { PriceOverridesRepository } from './price-overrides.repository';
import { UnitsRepository } from './units.repository';

/**
 * The price-override lifecycle (PRD-product P0-2): list / add / remove dated
 * prices layered over a unit's base. Only the lifecycle lives here - the
 * PRICING (which override covers which night) is quote()'s alone, so this
 * service can be deleted without a second price authority appearing anywhere.
 *
 * Deliberately NO archived gate (EARS OV-07): pricing a retired unit is
 * harmless - the §5.3 booking chokepoint is what guards selling - and unit
 * field edits already follow the same rule.
 *
 * Staff may do all of this for assigned units (EARS ISO-05): pricing an
 * assigned unit is OPERATING it, like the basePriceIdr edit they already have;
 * the ADR-0032 verb line reserves tenant-shape verbs. RLS is what scopes them -
 * no route code filters by property.
 */
@Injectable()
export class PriceOverridesService {
  constructor(
    private readonly repo: PriceOverridesRepository,
    private readonly units: UnitsRepository,
    private readonly db: TenantDbService,
  ) {}

  async list(unitId: string): Promise<PriceOverrideResponse[]> {
    await this.assertUnitOwned(unitId);
    const rows = await this.repo.findByUnit(unitId);
    return rows.map((row) => this.toResponse(row));
  }

  /**
   * One unit of work: the ownership 404, the friendly overlap pre-check and the
   * INSERT share a transaction via db.run's flat join (#72). The pre-check is
   * UX; a create racing past it hits `price_override_no_overlap` and the
   * interceptor maps the constraint to the IDENTICAL 409 (§5.3) - the api spec
   * proves both paths byte-equal.
   */
  async create(
    unitId: string,
    dto: CreatePriceOverrideRequest,
  ): Promise<PriceOverrideResponse> {
    return this.db.run(async () => {
      await this.assertUnitOwned(unitId);
      if (await this.repo.overlapExists(unitId, dto.from, dto.to)) {
        throw priceOverrideOverlap();
      }
      const row = await this.repo.create({
        unitId,
        fromDate: dto.from,
        toDate: dto.to,
        nightlyPriceIdr: BigInt(dto.nightlyPriceIdr),
      });
      return this.toResponse(row);
    });
  }

  /** 404 when unknown or another tenant's - existence is hidden (api-spec §1). */
  async remove(id: string): Promise<void> {
    if (!(await this.repo.delete(id))) {
      throw new NotFoundException('Price override not found');
    }
  }

  private async assertUnitOwned(unitId: string): Promise<void> {
    // Purely for the 404 (unknown / cross-tenant / staff-unassigned all read as
    // zero rows under RLS). Correctness is the composite FK's: a cross-tenant
    // override is unrepresentable with or without this check.
    if (!(await this.units.findById(unitId))) {
      throw new NotFoundException('Unit not found');
    }
  }

  private toResponse(row: UnitPriceOverride): PriceOverrideResponse {
    return {
      id: row.id,
      unitId: row.unitId,
      // Half-open [from, to) on the wire, like every range (db-design §4.2).
      from: row.fromDate,
      to: row.toDate,
      // The one place this bigint column becomes a JSON number (api-spec §8.4).
      nightlyPriceIdr: toRupiah(row.nightlyPriceIdr),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
