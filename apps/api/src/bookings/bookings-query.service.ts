import { Injectable, NotFoundException } from '@nestjs/common';
import {
  bookingDetailSchema,
  countNights,
  toRupiah,
  type BookingDetail,
  type BookingRow,
  type ListBookingsQuery,
} from '@sambung/shared';
import { bookingsToCsv, type BookingCsvRow } from './bookings-csv';
import {
  BookingsQueryRepository,
  type BookingDetailRow,
  type BookingExportRow,
  type BookingListRow,
} from './bookings-query.repository';

/**
 * The authed reservations read (api-spec §5.5, #49/#51). Thin: it turns a
 * validated query into repository filters and maps DB rows to the wire shape.
 * The tenant scoping lives in the repository (RLS + WHERE tenant_id); there is no
 * ownership check to run here because the query names no id the caller must own -
 * every row it can reach already belongs to its tenant.
 */
@Injectable()
export class BookingsQueryService {
  constructor(private readonly repo: BookingsQueryRepository) {}

  async list(query: ListBookingsQuery): Promise<BookingRow[]> {
    const rows = await this.repo.list({
      from: query.from,
      to: query.to,
      propertyId: query.propertyId,
      unitId: query.unitId,
      status: query.status,
      source: query.source,
    });
    return rows.map((row) => this.toRow(row));
  }

  /**
   * The reservations list as a CSV document (api-spec §5.5 CSV twin, #59). Uses
   * the repository's export query, which shares `list`'s exact filter predicate,
   * so the export respects the SAME active filters as `GET /bookings` by
   * construction. Money crosses to the CSV straight from the `bigint` as exact
   * decimal digits - never through a float - so a large rupiah value is unmangled.
   */
  async exportCsv(query: ListBookingsQuery): Promise<string> {
    const rows = await this.repo.listForExport({
      from: query.from,
      to: query.to,
      propertyId: query.propertyId,
      unitId: query.unitId,
      status: query.status,
      source: query.source,
    });
    return bookingsToCsv(rows.map((row) => this.toCsvRow(row)));
  }

  private toCsvRow(row: BookingExportRow): BookingCsvRow {
    return {
      bookingId: row.id,
      property: row.propertyName,
      unit: row.unitName,
      // Raw guest name; a manual_block (or a contactless walk-in) has none.
      guest: row.guestName ?? '',
      checkIn: row.checkIn,
      checkOut: row.checkOut,
      nights: String(countNights(row.checkIn, row.checkOut)),
      source: row.source,
      status: row.status,
      guests: row.guestCount === null ? '' : String(row.guestCount),
      // bigint -> exact decimal string. NOT toRupiah/Number: this side never needs
      // a JS number, and the string is the whole point (no float, no separators, no
      // 1.23e9). A block carries no price -> empty cell.
      totalIdr: row.totalPriceIdr === null ? '' : row.totalPriceIdr.toString(),
    };
  }

  /** One booking in full for the detail view (api-spec §5.7, #50). 404 when the
   * id is unknown to this tenant - the repository's WHERE + RLS make a
   * cross-tenant id indistinguishable from a nonexistent one (404-over-403). */
  async getById(id: string): Promise<BookingDetail> {
    const row = await this.repo.getById(id);
    if (!row) {
      throw new NotFoundException('Booking not found');
    }
    return this.toDetail(row);
  }

  private toRow(row: BookingListRow): BookingRow {
    return {
      id: row.id,
      unitId: row.unitId,
      source: row.source,
      status: row.status,
      checkIn: row.checkIn,
      checkOut: row.checkOut,
      guestName: row.guestName,
      guestCount: row.guestCount,
      // Only a live hold carries one; every other status has null.
      holdExpiresAt: row.holdExpiresAt ? row.holdExpiresAt.toISOString() : null,
      // bigint column -> JSON number at the boundary (api-spec §8.4). Nullable:
      // a manual_block / import may carry no total.
      totalPriceIdr:
        row.totalPriceIdr === null ? null : toRupiah(row.totalPriceIdr),
    };
  }

  private toDetail(row: BookingDetailRow): BookingDetail {
    // Parse on the way out so the detail payload cannot silently widen.
    return bookingDetailSchema.parse({
      ...this.toRow(row),
      guestPhone: row.guestPhone,
      guestEmail: row.guestEmail,
      propertyId: row.propertyId,
      propertyName: row.propertyName,
      unitName: row.unitName,
    });
  }
}
