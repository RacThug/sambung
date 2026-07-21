import { parseCalendar } from './ical-parse';

/**
 * The iCalendar IMPORT parser (#56, boss fight #3). Pure, no DB - the load-bearing
 * format logic on the ADVERSARIAL side of channel sync (an OTA's feed is external
 * input, invariant: trust none of it). Hand-rolled for the narrow subset OTAs
 * emit - all-day `VALUE=DATE` VEVENTs with UID/DTSTART/DTEND - the symmetric call
 * ADR-0016 made for the export serializer (ADR-0025).
 *
 * Three guarantees these tests pin:
 *  1. A DOUBTFUL feed parses to `{ ok: false }`, never a partial event list - a
 *     truncated download (no terminating END:VCALENDAR) must be indistinguishable
 *     from junk, so the importer can refuse to reconcile it (never mass-cancel).
 *  2. A single malformed VEVENT is SKIPPED, never fatal - one bad event in a
 *     healthy feed must not sink the whole pull.
 *  3. A value is resolved to the date it falls on in the PROPERTY's zone (#145,
 *     ADR-0028) - and only a UTC-stamped one is converted at all.
 */
describe('parseCalendar', () => {
  // Bali (WITA, UTC+8): the default zone and what every legacy case below assumed
  // implicitly before #145 made it explicit.
  const WITA = 'Asia/Makassar';
  const WIB = 'Asia/Jakarta'; // Java, UTC+7
  const WIT = 'Asia/Jayapura'; // Papua, UTC+9

  const parse = (body: string, timeZone: string = WITA) =>
    parseCalendar(body, timeZone);

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
    const res = parse(wrap(vevent()));
    expect(res).toEqual({
      ok: true,
      events: [{ uid: 'evt-1', start: '2026-08-01', end: '2026-08-04' }],
      foreignTimeZones: [],
    });
  });

  // THE half-open assertion (invariant #4): DTEND stays exclusive, verbatim - the
  // checkout date, mirroring the export serializer. Aug 1-3 busy, Aug 4 free.
  it('keeps DTEND exclusive (half-open), no arithmetic', () => {
    const res = parse(wrap(vevent({ dtstart: '20260801', dtend: '20260804' })));
    expect(res).toMatchObject({
      events: [{ start: '2026-08-01', end: '2026-08-04' }],
    });
  });

  it('parses multiple VEVENTs, preserving each UID', () => {
    const res = parse(
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
    const res = parse(ics);
    expect(res).toMatchObject({ events: [{ uid: longUid }] });
  });

  it('extracts the date from a DATE-TIME DTSTART/DTEND', () => {
    // Mid-UTC-day: 14:00Z is 22:00 in Bali, still the same calendar date. The
    // undramatic case - a timed value well inside the day converts to itself.
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:timed',
      'DTSTART:20260801T140000Z',
      'DTEND:20260804T110000Z',
      'END:VEVENT',
    );
    expect(parse(ics)).toMatchObject({
      events: [{ uid: 'timed', start: '2026-08-01', end: '2026-08-04' }],
    });
  });

  it('treats a DTSTART-only all-day VEVENT as a one-night block (DTEND = start + 1)', () => {
    const res = parse(wrap(vevent({ dtend: null as unknown as string })));
    expect(res).toMatchObject({
      events: [{ start: '2026-08-01', end: '2026-08-02' }],
    });
  });

  it('is case-insensitive on property/component names', () => {
    const ics =
      'begin:vcalendar\r\nbegin:vevent\r\nuid:low\r\n' +
      'dtstart;value=date:20260801\r\ndtend;value=date:20260803\r\n' +
      'end:vevent\r\nend:vcalendar\r\n';
    expect(parse(ics)).toMatchObject({
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
    expect(parse(ics)).toMatchObject({ events: [{ uid: 'real' }] });
  });

  it('returns a valid-but-empty calendar as ok with zero events', () => {
    const res = parse(wrap());
    expect(res).toEqual({ ok: true, events: [], foreignTimeZones: [] });
  });

  // --- Property-local dates (#145, ADR-0028) -------------------------------
  //
  // The bug: a UTC-stamped value names an INSTANT, not a date, and taking its
  // leading YYYYMMDD imported the block a night early near the day boundary.
  // These cases are deliberately zone-DISCRIMINATING - the issue's own 17:00Z
  // example is a poor witness, because WIB and WITA both land on 2 Aug.

  const timed = (dtstart: string, dtend: string): string =>
    wrap(
      'BEGIN:VEVENT',
      'UID:timed',
      `DTSTART:${dtstart}`,
      `DTEND:${dtend}`,
      'END:VEVENT',
    );

  it('resolves a UTC DTSTART to the date it falls on in the property zone', () => {
    // 16:30Z = 23:30 on 1 Aug in Java, but 00:30 on 2 Aug in Bali and Papua.
    const ics = timed('20260801T163000Z', '20260805T163000Z');
    expect(parse(ics, WIB)).toMatchObject({
      events: [{ start: '2026-08-01' }],
    });
    expect(parse(ics, WITA)).toMatchObject({
      events: [{ start: '2026-08-02' }],
    });
    expect(parse(ics, WIT)).toMatchObject({
      events: [{ start: '2026-08-02' }],
    });
  });

  it('separates WITA from WIT at the hour that only Papua has crossed', () => {
    // 15:30Z = 23:30 on 1 Aug in Bali, 00:30 on 2 Aug in Papua.
    const ics = timed('20260801T153000Z', '20260805T153000Z');
    expect(parse(ics, WITA)).toMatchObject({
      events: [{ start: '2026-08-01' }],
    });
    expect(parse(ics, WIT)).toMatchObject({
      events: [{ start: '2026-08-02' }],
    });
  });

  // Both edges or neither: converting only DTSTART would stretch or shrink the
  // stay rather than move it, which is a worse bug than the one being fixed.
  it('converts DTEND on the same terms as DTSTART (the range moves, not stretches)', () => {
    const ics = timed('20260801T163000Z', '20260804T163000Z');
    expect(parse(ics, WIB)).toMatchObject({
      events: [{ start: '2026-08-01', end: '2026-08-04' }],
    });
    expect(parse(ics, WITA)).toMatchObject({
      events: [{ start: '2026-08-02', end: '2026-08-05' }],
    });
  });

  // The three forms that need NO zone - right by construction, not by luck.
  it('leaves an all-day VALUE=DATE untouched in every zone', () => {
    const ics = wrap(vevent({ dtstart: '20260801', dtend: '20260804' }));
    for (const zone of [WIB, WITA, WIT]) {
      expect(parse(ics, zone)).toMatchObject({
        events: [{ start: '2026-08-01', end: '2026-08-04' }],
      });
    }
  });

  it('leaves a FLOATING DATE-TIME untouched (floating time is already local)', () => {
    // No Z, no TZID: RFC 5545 says this is the observer's local time, and the
    // observer of a property calendar is the property.
    const ics = timed('20260801T163000', '20260804T163000');
    for (const zone of [WIB, WITA, WIT]) {
      expect(parse(ics, zone)).toMatchObject({
        events: [{ start: '2026-08-01', end: '2026-08-04' }],
      });
    }
  });

  it('leaves a TZID DATE-TIME untouched and reports nothing when it matches', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:tzid',
      'DTSTART;TZID=Asia/Makassar:20260801T163000',
      'DTEND;TZID=Asia/Makassar:20260804T163000',
      'END:VEVENT',
    );
    expect(parse(ics, WITA)).toMatchObject({
      events: [{ start: '2026-08-01', end: '2026-08-04' }],
      foreignTimeZones: [],
    });
  });

  // The one case left unhandled (Q4): report it, don't guess. The date part is
  // still taken verbatim - behaviour is unchanged - but the importer can now say
  // so, which is the whole point of not failing silently.
  it('reports a TZID that is not the property zone, without changing behaviour', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:foreign',
      'DTSTART;TZID=America/New_York:20260801T163000',
      'DTEND;TZID=America/New_York:20260804T163000',
      'END:VEVENT',
    );
    expect(parse(ics, WITA)).toMatchObject({
      events: [{ start: '2026-08-01', end: '2026-08-04' }],
      foreignTimeZones: ['America/New_York'],
    });
  });

  it('reports each foreign zone once, however many events name it', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:a',
      'DTSTART;TZID=Europe/Berlin:20260801T100000',
      'DTEND;TZID=Europe/Berlin:20260803T100000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:b',
      'DTSTART;TZID=Europe/Berlin:20260810T100000',
      'DTEND;TZID=Europe/Berlin:20260812T100000',
      'END:VEVENT',
    );
    expect(parse(ics, WITA)).toMatchObject({
      foreignTimeZones: ['Europe/Berlin'],
    });
  });

  // A VTIMEZONE component declares a zone but does not stamp an event with one.
  // It is outside any VEVENT, so it must not be mistaken for a foreign TZID.
  it('does not treat a VTIMEZONE component as a foreign zone', () => {
    const ics = wrap(
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'END:VTIMEZONE',
      vevent({ uid: 'real' }),
    );
    expect(parse(ics, WITA)).toMatchObject({ foreignTimeZones: [] });
  });

  // The parser's "never throws" guarantee has to survive a bad zone too: an
  // unusable one is an UNHEALTHY parse (change nothing, say why), not a
  // RangeError escaping from inside a cron.
  it('rejects an unusable time zone instead of throwing', () => {
    const res = parse(wrap(vevent()), 'Mars/Olympus_Mons');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('time zone');
  });

  // Date.UTC ROLLS OVER (31 Feb -> 3 Mar), so a UTC value must be validated by
  // round-trip, not by a range check. Otherwise an impossible date silently
  // becomes a real one three nights away - and, worse, the UTC and VALUE=DATE
  // paths disagree about the same input. One calendar-validity rule, both forms.
  it('skips an impossible calendar date rather than rolling it over', () => {
    const rolled = wrap(
      'BEGIN:VEVENT',
      'UID:rollover',
      'DTSTART:20260231T120000Z',
      'DTEND:20260305T120000Z',
      'END:VEVENT',
      vevent({ uid: 'good' }),
    );
    expect(parse(rolled)).toMatchObject({ events: [{ uid: 'good' }] });

    // The same impossible date as VALUE=DATE must be skipped identically.
    const allDay = wrap(
      vevent({ uid: 'bad', dtstart: '20260231', dtend: '20260305' }),
      vevent({ uid: 'good' }),
    );
    expect(parse(allDay)).toMatchObject({ events: [{ uid: 'good' }] });
  });

  // Two ways a hostile feed can make Intl emit something that is not YYYY-MM-DD:
  // `year: 'numeric'` does not zero-pad, and Date.UTC maps years 0-99 to 1900+.
  it('never returns a malformed or century-shifted date for an absurd year', () => {
    for (const dtstart of ['01000101T000000Z', '00500101T000000Z']) {
      const res = parse(
        wrap(
          'BEGIN:VEVENT',
          'UID:ancient',
          `DTSTART:${dtstart}`,
          'DTEND:20301231T000000Z',
          'END:VEVENT',
        ),
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      for (const e of res.events) {
        expect(e.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // 0050 must not silently become 1950 - that is a 1900-year import.
        expect(e.start.slice(0, 4)).toBe(dtstart.slice(0, 4));
      }
    }
  });

  // RFC 5545 spells the UTC designator 'Z', but this is the adversarial side:
  // a lowercase 'z' must not fall through to the unconverted path, which would
  // silently reinstate the very off-by-one #145 exists to remove.
  it('treats a lowercase z as the UTC designator', () => {
    const ics = timed('20260801T163000z', '20260805T163000z');
    expect(parse(ics, WITA)).toMatchObject({
      events: [{ start: '2026-08-02' }],
    });
  });

  // RFC 5545 §3.1 allows a quoted param value. Keeping the quotes would make the
  // property's OWN zone read as foreign, so the one diagnostic the design leans
  // on would cry wolf on a perfectly ordinary feed.
  it('unquotes a TZID param before comparing it to the property zone', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:quoted',
      'DTSTART;TZID="Asia/Makassar":20260801T163000',
      'DTEND;TZID="Asia/Makassar":20260804T163000',
      'END:VEVENT',
    );
    expect(parse(ics, WITA)).toMatchObject({
      events: [{ start: '2026-08-01', end: '2026-08-04' }],
      foreignTimeZones: [],
    });
  });

  it('skips a UTC value whose time components are impossible', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:badtime',
      'DTSTART:20260801T250000Z',
      'DTEND:20260804T110000Z',
      'END:VEVENT',
      vevent({ uid: 'good' }),
    );
    expect(parse(ics)).toMatchObject({ events: [{ uid: 'good' }] });
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
    expect(parse(ics)).toMatchObject({ events: [{ uid: 'good' }] });
  });

  it('skips a VEVENT whose range is empty or inverted (end <= start)', () => {
    const ics = wrap(
      vevent({ uid: 'inverted', dtstart: '20260804', dtend: '20260801' }),
      vevent({ uid: 'empty', dtstart: '20260801', dtend: '20260801' }),
      vevent({ uid: 'good', dtstart: '20260801', dtend: '20260802' }),
    );
    expect(parse(ics)).toMatchObject({ events: [{ uid: 'good' }] });
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
    expect(parse(ics)).toMatchObject({ events: [{ uid: 'good' }] });
  });

  // --- Doubtful feed → ok:false, so the importer never reconciles it -------

  it('rejects an empty body', () => {
    expect(parse('')).toMatchObject({ ok: false });
  });

  it('rejects a body with no VCALENDAR envelope (e.g. an HTML error page)', () => {
    expect(parse('<html><body>404 Not Found</body></html>')).toMatchObject({
      ok: false,
    });
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
    expect(parse(truncated)).toMatchObject({ ok: false });
  });
});
