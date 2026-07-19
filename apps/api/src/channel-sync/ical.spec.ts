import { EVENT_SUMMARY, buildCalendar } from './ical';

/**
 * The pure iCalendar serializer (api-spec §7.6, ADR-0016). No app boot, no DB -
 * this is the load-bearing format logic, so it's pinned directly. The E2E feed
 * test (channel-sync.spec) proves it's wired to real confirmed bookings.
 */
describe('buildCalendar', () => {
  const dtstamp = new Date('2026-07-19T08:30:00.000Z');

  const oneEvent = (
    over: Partial<{ uid: string; start: string; end: string }> = {},
  ) =>
    buildCalendar({
      prodId: '-//Test//EN',
      dtstamp,
      events: [
        { uid: 'booking-123', start: '2026-08-01', end: '2026-08-04', ...over },
      ],
    });

  it('wraps events in a VCALENDAR with the required headers', () => {
    const ics = oneEvent();
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
  });

  it('emits UID = the booking id (api-spec §7.6)', () => {
    expect(oneEvent({ uid: 'abc-uuid' })).toContain('UID:abc-uuid');
  });

  // THE half-open assertion (invariant #4, AC): a stay [check_in, check_out) maps
  // to all-day DTSTART/DTEND with DTEND exclusive - the checkout date verbatim, so
  // an OTA sees Aug 1-3 busy and Aug 4 free.
  it('maps [check_in, check_out) to all-day DTSTART inclusive / DTEND exclusive', () => {
    const ics = oneEvent({ start: '2026-08-01', end: '2026-08-04' });
    expect(ics).toContain('DTSTART;VALUE=DATE:20260801');
    expect(ics).toContain('DTEND;VALUE=DATE:20260804');
  });

  // No guest name, email, phone, or price can appear: the fixed SUMMARY is the
  // only text on an event, and CalendarEvent has no field to carry PII.
  it('uses the fixed SUMMARY, never guest-derived text', () => {
    const ics = oneEvent();
    expect(ics).toContain(`SUMMARY:${EVENT_SUMMARY}`);
    expect(ics).toContain('SUMMARY:Unavailable (Sambung)');
  });

  it('stamps DTSTAMP as a UTC date-time', () => {
    expect(oneEvent()).toContain('DTSTAMP:20260719T083000Z');
  });

  it('terminates every line with CRLF', () => {
    const ics = oneEvent();
    // Every physical line ends in \r\n, and none is a bare \n.
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.split('\r\n').join('')).not.toContain('\n');
  });

  it('emits one VEVENT per booking, and an empty (valid) calendar for none', () => {
    const two = buildCalendar({
      prodId: '-//Test//EN',
      dtstamp,
      events: [
        { uid: 'a', start: '2026-08-01', end: '2026-08-02' },
        { uid: 'b', start: '2026-08-05', end: '2026-08-07' },
      ],
    });
    expect(two.match(/BEGIN:VEVENT/g)).toHaveLength(2);

    const none = buildCalendar({ prodId: '-//Test//EN', dtstamp, events: [] });
    expect(none).toContain('BEGIN:VCALENDAR');
    expect(none).toContain('END:VCALENDAR');
    expect(none).not.toContain('BEGIN:VEVENT');
  });

  it('folds a line longer than 75 octets with CRLF + space', () => {
    const longUid = 'x'.repeat(200);
    const ics = buildCalendar({
      prodId: '-//Test//EN',
      dtstamp,
      events: [{ uid: longUid, start: '2026-08-01', end: '2026-08-02' }],
    });
    // Every physical line (split on CRLF) is <= 75 octets.
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Unfolding (drop CRLF + leading space) restores the full UID.
    expect(ics.replace(/\r\n /g, '')).toContain(`UID:${longUid}`);
  });

  it('escapes iCalendar TEXT special characters', () => {
    // A uid with a comma/semicolon/backslash must be escaped, not emitted raw.
    const ics = oneEvent({ uid: 'a,b;c\\d' });
    expect(ics).toContain('UID:a\\,b\\;c\\\\d');
  });
});
