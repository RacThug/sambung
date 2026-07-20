import { parseCalendar } from './ical-parse';

/**
 * The iCalendar IMPORT parser (#56, boss fight #3). Pure, no DB - the load-bearing
 * format logic on the ADVERSARIAL side of channel sync (an OTA's feed is external
 * input, invariant: trust none of it). Hand-rolled for the narrow subset OTAs
 * emit - all-day `VALUE=DATE` VEVENTs with UID/DTSTART/DTEND - the symmetric call
 * ADR-0016 made for the export serializer (ADR-0025).
 *
 * Two guarantees these tests pin:
 *  1. A DOUBTFUL feed parses to `{ ok: false }`, never a partial event list - a
 *     truncated download (no terminating END:VCALENDAR) must be indistinguishable
 *     from junk, so the importer can refuse to reconcile it (never mass-cancel).
 *  2. A single malformed VEVENT is SKIPPED, never fatal - one bad event in a
 *     healthy feed must not sink the whole pull.
 */
describe('parseCalendar', () => {
  const wrap = (...lines: string[]): string =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n') +
    '\r\n';

  const vevent = (
    over: Partial<{ uid: string; dtstart: string; dtend: string }> = {},
  ): string => {
    const { uid = 'evt-1', dtstart, dtend } = over;
    const lines = ['BEGIN:VEVENT', `UID:${uid}`];
    lines.push(`DTSTART;VALUE=DATE:${dtstart ?? '20260801'}`);
    if (dtend !== null) lines.push(`DTEND;VALUE=DATE:${dtend ?? '20260804'}`);
    lines.push('END:VEVENT');
    return lines.join('\r\n');
  };

  // --- The happy path ------------------------------------------------------

  it('parses a valid all-day VEVENT into one event', () => {
    const res = parseCalendar(wrap(vevent()));
    expect(res).toEqual({
      ok: true,
      events: [{ uid: 'evt-1', start: '2026-08-01', end: '2026-08-04' }],
    });
  });

  // THE half-open assertion (invariant #4): DTEND stays exclusive, verbatim - the
  // checkout date, mirroring the export serializer. Aug 1-3 busy, Aug 4 free.
  it('keeps DTEND exclusive (half-open), no arithmetic', () => {
    const res = parseCalendar(
      wrap(vevent({ dtstart: '20260801', dtend: '20260804' })),
    );
    expect(res).toMatchObject({
      events: [{ start: '2026-08-01', end: '2026-08-04' }],
    });
  });

  it('parses multiple VEVENTs, preserving each UID', () => {
    const res = parseCalendar(
      wrap(
        vevent({ uid: 'a', dtstart: '20260801', dtend: '20260803' }),
        vevent({ uid: 'b', dtstart: '20260810', dtend: '20260812' }),
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events.map((e) => e.uid)).toEqual(['a', 'b']);
  });

  it('unfolds a folded (75-octet-wrapped) UID line', () => {
    const longUid = 'x'.repeat(120);
    // RFC 5545 §3.1 folding: a CRLF + a single leading space continues the line.
    const folded = `UID:${longUid.slice(0, 40)}\r\n ${longUid.slice(40)}`;
    const ics = wrap(
      'BEGIN:VEVENT',
      folded,
      'DTSTART;VALUE=DATE:20260801',
      'DTEND;VALUE=DATE:20260802',
      'END:VEVENT',
    );
    const res = parseCalendar(ics);
    expect(res).toMatchObject({ events: [{ uid: longUid }] });
  });

  it('extracts the date from a DATE-TIME DTSTART/DTEND', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:timed',
      'DTSTART:20260801T140000Z',
      'DTEND:20260804T110000Z',
      'END:VEVENT',
    );
    expect(parseCalendar(ics)).toMatchObject({
      events: [{ uid: 'timed', start: '2026-08-01', end: '2026-08-04' }],
    });
  });

  it('treats a DTSTART-only all-day VEVENT as a one-night block (DTEND = start + 1)', () => {
    const res = parseCalendar(
      wrap(vevent({ dtend: null as unknown as string })),
    );
    expect(res).toMatchObject({
      events: [{ start: '2026-08-01', end: '2026-08-02' }],
    });
  });

  it('is case-insensitive on property/component names', () => {
    const ics =
      'begin:vcalendar\r\nbegin:vevent\r\nuid:low\r\n' +
      'dtstart;value=date:20260801\r\ndtend;value=date:20260803\r\n' +
      'end:vevent\r\nend:vcalendar\r\n';
    expect(parseCalendar(ics)).toMatchObject({
      events: [{ uid: 'low', start: '2026-08-01', end: '2026-08-03' }],
    });
  });

  it('ignores non-VEVENT components and unknown properties', () => {
    const ics = wrap(
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Makassar',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:real',
      'SUMMARY:Reserved',
      'X-AIRBNB-THING:whatever',
      'DTSTART;VALUE=DATE:20260801',
      'DTEND;VALUE=DATE:20260802',
      'END:VEVENT',
    );
    expect(parseCalendar(ics)).toMatchObject({ events: [{ uid: 'real' }] });
  });

  it('returns a valid-but-empty calendar as ok with zero events', () => {
    const res = parseCalendar(wrap());
    expect(res).toEqual({ ok: true, events: [] });
  });

  // --- Skipping bad VEVENTs (never fatal) ----------------------------------

  it('skips a VEVENT with no UID (cannot be deduped) but keeps the good ones', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20260801',
      'DTEND;VALUE=DATE:20260803',
      'END:VEVENT',
      vevent({ uid: 'good' }),
    );
    expect(parseCalendar(ics)).toMatchObject({ events: [{ uid: 'good' }] });
  });

  it('skips a VEVENT whose range is empty or inverted (end <= start)', () => {
    const ics = wrap(
      vevent({ uid: 'inverted', dtstart: '20260804', dtend: '20260801' }),
      vevent({ uid: 'empty', dtstart: '20260801', dtend: '20260801' }),
      vevent({ uid: 'good', dtstart: '20260801', dtend: '20260802' }),
    );
    expect(parseCalendar(ics)).toMatchObject({ events: [{ uid: 'good' }] });
  });

  it('skips a VEVENT with an unparseable DTSTART', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:nodate',
      'DTSTART;VALUE=DATE:notadate',
      'DTEND;VALUE=DATE:20260803',
      'END:VEVENT',
      vevent({ uid: 'good' }),
    );
    expect(parseCalendar(ics)).toMatchObject({ events: [{ uid: 'good' }] });
  });

  // --- Doubtful feed → ok:false, so the importer never reconciles it -------

  it('rejects an empty body', () => {
    expect(parseCalendar('')).toMatchObject({ ok: false });
  });

  it('rejects a body with no VCALENDAR envelope (e.g. an HTML error page)', () => {
    expect(
      parseCalendar('<html><body>404 Not Found</body></html>'),
    ).toMatchObject({ ok: false });
  });

  // The truncation signature: a feed cut off mid-stream keeps BEGIN:VCALENDAR but
  // loses its terminating END:VCALENDAR. It MUST be rejected even though earlier
  // VEVENTs parsed cleanly - reconciling a partial feed would mass-cancel.
  it('rejects a truncated feed (missing END:VCALENDAR) even with a complete VEVENT', () => {
    const truncated =
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' +
      'BEGIN:VEVENT\r\nUID:a\r\nDTSTART;VALUE=DATE:20260801\r\n' +
      'DTEND;VALUE=DATE:20260803\r\nEND:VEVENT\r\n' +
      'BEGIN:VEVENT\r\nUID:b\r\nDTSTART;VALUE=DATE:20260810'; // cut here
    expect(parseCalendar(truncated)).toMatchObject({ ok: false });
  });
});
