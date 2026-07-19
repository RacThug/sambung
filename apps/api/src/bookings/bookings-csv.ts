import type { BookingSource, BookingStatus } from '@sambung/shared';

/**
 * The reservations CSV export, as a PURE serializer (api-spec §5.5 CSV twin, #59).
 *
 * The service maps DB rows into `BookingCsvRow` (money bigint -> exact decimal
 * string, nights computed); this module only lays the cells out and escapes them.
 * Split so the escaping - the part that "opens correctly in a spreadsheet" hinges
 * on - is unit-tested without a DB or HTTP, and so the column contract lives in one
 * place.
 */

/** One reservation's cells, already reduced to strings by the service. `totalIdr`
 * and `guests` are exact decimal strings (or '' when absent) - never floats, never
 * separators, never scientific notation, so a large rupiah value survives the round
 * trip a spreadsheet would otherwise mangle. */
export interface BookingCsvRow {
  bookingId: string;
  property: string;
  unit: string;
  guest: string;
  checkIn: string;
  checkOut: string;
  nights: string;
  source: BookingSource;
  status: BookingStatus;
  guests: string;
  totalIdr: string;
}

/**
 * Column order + headers - the stable contract a spreadsheet (or a downstream
 * importer) relies on. Adding a column is one line here and it appends; the order
 * of the existing columns never shifts. Enum values (`source`, `status`) are
 * exported RAW - a data export is language-neutral, and the human labels are the
 * web's to own (ADR-0012), so there is no copy to drift here.
 */
const COLUMNS: { header: string; cell: (r: BookingCsvRow) => string }[] = [
  { header: 'Booking ID', cell: (r) => r.bookingId },
  { header: 'Property', cell: (r) => r.property },
  { header: 'Unit', cell: (r) => r.unit },
  { header: 'Guest', cell: (r) => r.guest },
  { header: 'Check-in', cell: (r) => r.checkIn },
  { header: 'Check-out', cell: (r) => r.checkOut },
  { header: 'Nights', cell: (r) => r.nights },
  { header: 'Source', cell: (r) => r.source },
  { header: 'Status', cell: (r) => r.status },
  { header: 'Guests', cell: (r) => r.guests },
  { header: 'Total (IDR)', cell: (r) => r.totalIdr },
];

/** The header row, exported for tests asserting the stable column contract. */
export const CSV_HEADERS: readonly string[] = COLUMNS.map((c) => c.header);

const CRLF = '\r\n'; // RFC 4180 record separator - what Excel/Sheets expect.
const BOM = String.fromCharCode(0xfeff); // U+FEFF: makes Excel read UTF-8.

// A field whose first character is one of these is treated by Excel/Sheets as a
// FORMULA, not text - the CSV-injection vector. Guest names come from the no-auth
// public funnel (attacker-controlled), so a name like `=HYPERLINK(...)` could run
// when the owner opens the export (CLAUDE.md "trust no external input").
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
// RFC 4180: quote a field containing a comma, double-quote, CR or LF.
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Escape one field for RFC 4180, and neutralise CSV/formula injection.
 *
 * If the value would be read as a formula, prefix a single quote (the Excel/OWASP
 * convention that forces a cell to text) and quote it. Otherwise quote only when
 * the value carries a delimiter/quote/newline, doubling any inner quote. A positive
 * integer never starts with a trigger char, so the money and count columns are
 * emitted verbatim - the "integer IDR unmangled" guarantee.
 */
export function escapeCsvField(value: string): string {
  const injectable = FORMULA_TRIGGER.test(value);
  const v = injectable ? `'${value}` : value;
  if (injectable || NEEDS_QUOTING.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/**
 * Serialise reservations into one RFC 4180 CSV document: a UTF-8 BOM, the header
 * row, one row per reservation, CRLF-separated, with a trailing CRLF. An empty
 * result is still a valid file - the header row alone, so a filtered export that
 * matches nothing opens as an empty sheet rather than a broken download.
 */
export function bookingsToCsv(rows: BookingCsvRow[]): string {
  const records = [
    CSV_HEADERS.map((h) => escapeCsvField(h)),
    ...rows.map((r) => COLUMNS.map((c) => escapeCsvField(c.cell(r)))),
  ];
  return BOM + records.map((cells) => cells.join(',')).join(CRLF) + CRLF;
}
