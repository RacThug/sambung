import { Injectable, NotFoundException } from '@nestjs/common';
import {
  availabilityResponseSchema,
  coalesceRanges,
  countNights,
  meetsMinStay,
  quoteTotalIdr,
  toRupiah,
  type AvailabilityQuery,
  type AvailabilityReason,
  type AvailabilityResponse,
} from '@sambung/shared';
import { PublicScope } from '../common/public-scope.service';
import { TenantDbService } from '../db/tenant-db.service';
import { AvailabilityRepository } from './availability.repository';

/**
 * The outcome of the interval computation, BEFORE any HTTP framing. `archived`
 * and `not_found` are surfaced rather than thrown so each caller frames them for
 * its own verb: the read (#47) hides both as 404 (api-spec §4.8, ADR-0008); the
 * booking write (#48) will answer 409 for `archived` and use `ok`'s totalPriceIdr.
 */
export type QuoteOutcome =
  | { kind: 'ok'; response: AvailabilityResponse }
  | { kind: 'archived' }
  | { kind: 'not_found' };

/**
 * Boss fight #2 - the availability quote (api-spec §5.1, FR-CAL-1/2, #47).
 *
 * `quote()` is the single interval authority: #48's booking write re-checks
 * availability inside its transaction by calling this SAME method (the db.run
 * seam joins its transaction, #72), so the read and the write share one
 * definition of "free". The overlap detection itself is SQL beside the exclusion
 * constraint (AvailabilityRepository); everything here is composition of the pure
 * primitives in @sambung/shared.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly scope: PublicScope,
    private readonly repo: AvailabilityRepository,
    private readonly db: TenantDbService,
  ) {}

  /**
   * The public entry: resolve the tenant from the unit id, quote, and frame the
   * read's answer. A nonexistent OR effectively-archived unit both come back as
   * 404 - indistinguishable, matching the public page that hides archived units
   * (ADR-0008). Parsed on the way out so the payload cannot silently widen.
   */
  async getPublicQuote(
    unitId: string,
    query: AvailabilityQuery,
  ): Promise<AvailabilityResponse> {
    // Establish who we act for BEFORE any tenant-scoped query. enterFromUnitId
    // 404s a unit that does not exist at all; archived is judged just below.
    await this.scope.enterFromUnitId(unitId);

    const outcome = await this.quote(unitId, query.from, query.to);
    if (outcome.kind !== 'ok') {
      throw new NotFoundException('Unit not found');
    }
    return availabilityResponseSchema.parse(outcome.response);
  }

  /**
   * The interval computation, reusable by #48. Assumes a principal is set; joins
   * an open transaction if the caller already has one (so #48's in-transaction
   * re-check runs against its own uncommitted state), or opens one otherwise.
   *
   * `blockedRanges` is unconditional - every occupying booking clipped into the
   * window - so a non-empty one IS the `overlap` signal; there is no separate
   * availability query. Price is always computed (a placeholder unit quotes at 0).
   */
  async quote(unitId: string, from: string, to: string): Promise<QuoteOutcome> {
    return this.db.run(async () => {
      const pricing = await this.repo.fetchUnitPricing(unitId);
      if (!pricing) return { kind: 'not_found' };
      if (pricing.archived) return { kind: 'archived' };

      const blockedRanges = coalesceRanges(
        await this.repo.findBlockedRanges(unitId, from, to),
      );
      const nights = countNights(from, to);
      const overlap = blockedRanges.length > 0;
      const minStayOk = meetsMinStay(nights, pricing.minStay);

      const reasons: AvailabilityReason[] = [];
      if (overlap) reasons.push('overlap');
      if (!minStayOk) reasons.push('min_stay');

      return {
        kind: 'ok',
        response: {
          available: !overlap && minStayOk,
          nights,
          totalPriceIdr: toRupiah(quoteTotalIdr(pricing.basePriceIdr, nights)),
          minStay: pricing.minStay,
          reasons,
          blockedRanges,
        },
      };
    });
  }
}
