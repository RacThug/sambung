import {
  CSV_HEADERS,
  bookingsToCsv,
  escapeCsvField,
  type BookingCsvRow,
} from './bookings-csv';

/**
 * The CSV serializer's contract (#59), unit-tested without a DB or HTTP: RFC 4180
 * escaping, formula-injection neutralisation, and - the money guarantee the AC
 * names - integer IDR emitted UNMANGLED (no float, no separators, no scientific
 * notation). The endpoint's tenant scoping / filter behaviour lives in the
 * integration spec; here we pin the bytes.
 */

const BOM = '﻿';

const row = (over: Partial<BookingCsvRow> = {}): BookingCsvRow => ({
  bookingId: '11111111-1111-1111-1111-111111111111',
  property: 'Seminyak Villa',
  unit: 'Garden Room 1',
  guest: 'Wayan Test',
  checkIn: '2027-03-10',
  checkOut: '2027-03-14',
  nights: '4',
  source: 'direct',
  status: 'confirmed',
  guests: '2',
  totalIdr: '4500000',
  ...over,
});

/** Split a CSV document into records the way a spreadsheet does: strip the BOM,
 * drop the trailing terminator, split on CRLF. */
function records(csv: string): string[] {
  const body = csv.startsWith(BOM) ? csv.slice(BOM.length) : csv;
  return body.replace(/\r\n$/, '').split('\r\n');
}

describe('bookings-csv', () => {
  it('emits a UTF-8 BOM, a CRLF-terminated header, then one record per row', () => {
    const csv = bookingsToCsv([row()]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);

    const recs = records(csv);
    expect(recs[0]).toBe(CSV_HEADERS.join(','));
    expect(recs).toHaveLength(2); // header + one data row
  });

  it('keeps a stable, documented column order', () => {
    expect(CSV_HEADERS).toEqual([
      'Booking ID',
      'Property',
      'Unit',
      'Guest',
      'Check-in',
      'Check-out',
      'Nights',
      'Source',
      'Status',
      'Guests',
      'Total (IDR)',
    ]);
  });

  it('emits integer IDR unmangled - exact digits, no float / separators / e-notation', () => {
    // A large rupiah value a spreadsheet would love to render as 1.5E+9.
    const csv = bookingsToCsv([row({ totalIdr: '1500000000' })]);
    const total = records(csv)[1].split(',').at(-1);
    expect(total).toBe('1500000000');
    expect(total).not.toMatch(/[.eE]/);
  });

  it('leaves an absent price / guest count as an empty cell', () => {
    const cells = records(
      bookingsToCsv([row({ totalIdr: '', guests: '' })]),
    )[1];
    // manual_block: trailing empty guests + total.
    expect(cells.endsWith(',,')).toBe(true);
  });

  it('quotes and doubles quotes for a comma/quote in a field (RFC 4180)', () => {
    expect(escapeCsvField('Smith, John')).toBe('"Smith, John"');
    expect(escapeCsvField('A "nice" villa')).toBe('"A ""nice"" villa"');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    // A plain field is left alone.
    expect(escapeCsvField('Garden Room 1')).toBe('Garden Room 1');
  });

  it('neutralises a formula-injection guest name', () => {
    // A name from the no-auth funnel that Excel would execute as a formula.
    expect(escapeCsvField('=HYPERLINK("http://evil","x")')).toBe(
      `"'=HYPERLINK(""http://evil"",""x"")"`,
    );
    // Other trigger chars are prefixed too.
    expect(escapeCsvField('+1')).toBe(`"'+1"`);
    expect(escapeCsvField('-cmd')).toBe(`"'-cmd"`);
    expect(escapeCsvField('@x')).toBe(`"'@x"`);
    // A positive integer never trips the guard - money stays exact.
    expect(escapeCsvField('4500000')).toBe('4500000');
  });

  it('escapes an injected guest name inside a full row without touching money', () => {
    const cells = records(
      bookingsToCsv([row({ guest: '=1+2', totalIdr: '9007199254740991' })]),
    )[1].split(',');
    // Guest cell is neutralised + quoted; the total is the exact integer.
    expect(cells[3]).toBe(`"'=1+2"`);
    expect(cells.at(-1)).toBe('9007199254740991');
  });

  it('is a valid file even with no rows - just the header', () => {
    const recs = records(bookingsToCsv([]));
    expect(recs).toEqual([CSV_HEADERS.join(',')]);
  });
});
