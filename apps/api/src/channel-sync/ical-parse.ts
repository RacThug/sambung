/**
 * A minimal, STRICT RFC-5545 (iCalendar) parser for the import pipeline (#56,
 * boss fight #3). The mirror image of ical.ts (the export serializer): where that
 * owns ~130 lines to control what leaves, this owns the parse of what an OTA
 * sends - the ADVERSARIAL side. Hand-rolled rather than a library (ADR-0025) for
 * the same reason the serializer is: the subset OTAs emit is trivial (all-day
 * `VALUE=DATE` VEVENTs with UID/DTSTART/DTEND, no RRULE, no VTIMEZONE that
 * matters), and the reliability-critical logic - "is this feed whole or
 * truncated?" - is ours to own explicitly, not to infer from a library's errors.
 *
 * Two guarantees, both load-bearing for the never-mass-cancel invariant:
 *
 *  1. **A doubtful feed yields `{ ok: false }`, never a partial event list.** The
 *     one signal that separates "the OTA cleared its calendar" from "the download
 *     was cut off" is the terminating `END:VCALENDAR`: a truncated feed keeps its
 *     `BEGIN` but loses its `END`. We reject the whole thing rather than reconcile
 *     a fragment - the importer only cancels absent UIDs on an `ok` parse.
 *  2. **A single malformed VEVENT is skipped, never fatal.** An event with no UID
 *     (undedupable), an unparseable date, or an empty/inverted range is dropped
 *     with the rest kept. Trust is confined to a validated `{uid, start, end}`.
 *
 * Dates are half-open `[start, end)` (invariant #4): `DTEND` is exclusive in
 * iCalendar too, so it maps to `check_out` with zero arithmetic - the exact
 * inverse of the serializer.
 *
 * The parse takes the property's time zone (#145, ADR-0028) because a UTC-stamped
 * value names no calendar date without one - see toIsoDate for which of the four
 * value forms that actually affects (one of them).
 */

/**
 * One busy span lifted from a feed. `start`/`end` are `YYYY-MM-DD`; `end` is
 * EXCLUSIVE (the checkout date). Only these three fields are ever trusted - an
 * OTA feed's SUMMARY/DESCRIPTION (guest names, notes) is deliberately dropped, so
 * imported PII cannot enter through this door.
 */
export interface ImportedEvent {
  uid: string;
  start: string;
  end: string;
}

/**
 * The outcome of a parse. `ok: false` means the body is not a trustworthy, whole
 * calendar (unterminated / not a VCALENDAR / empty) - the caller must treat it as
 * an unhealthy feed and change NOTHING. `ok: true` (even with zero events) means
 * a whole calendar parsed.
 *
 * `foreignTimeZones` is a DIAGNOSTIC, not a fault: the distinct `TZID` zones the
 * feed named that are NOT this property's (see toIsoDate). It rides on the result
 * envelope rather than on ImportedEvent deliberately - the trust boundary stays
 * three strings - and it is what makes the one remaining unhandled case loud
 * instead of silent. Normally empty, because no OTA we support emits TZID at all.
 */
export type ParseResult =
  | { ok: true; events: ImportedEvent[]; foreignTimeZones: string[] }
  | { ok: false; error: string };

/** Unfold RFC 5545 §3.1 folded lines: a CRLF/CR/LF followed by a single space or
 * tab is a continuation of the previous line, restored by dropping the break and
 * the leading whitespace. Done before splitting so a folded UID/date is whole. */
function unfold(body: string): string[] {
  return body
    .replace(/\r\n[ \t]/g, '')
    .replace(/[\r\n][ \t]/g, '')
    .split(/\r\n|\r|\n/);
}

/** Split a content line into its property NAME (upper-cased), its `TZID` param if
 * present, and the raw VALUE. `DTSTART;VALUE=DATE:20260801` →
 * `{ name: 'DTSTART', tzid: null, value: '20260801' }`.
 *
 * Every param but TZID is discarded (`VALUE=DATE` tells us nothing the value
 * itself doesn't). TZID is kept for ONE purpose: to notice a feed naming a zone
 * that isn't the property's - see toIsoDate. It never changes what we parse. */
function splitLine(
  line: string,
): { name: string; tzid: string | null; value: string } | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const semi = left.indexOf(';');
  const name = (semi === -1 ? left : left.slice(0, semi)).trim().toUpperCase();
  const tzid = semi === -1 ? null : (/;TZID=([^;:]+)/i.exec(left)?.[1] ?? null);
  return { name, tzid: tzid?.trim() || null, value: line.slice(colon + 1) };
}

/**
 * A property's local clock, resolved once per feed. `toLocalDate` turns an
 * instant into the calendar date it falls on THERE - the one thing an iCalendar
 * UTC value cannot tell us on its own.
 */
interface ZoneContext {
  timeZone: string;
  toLocalDate(instant: Date): string;
}

/**
 * Build the zone context, or null if the zone is unusable. Constructing the
 * formatter once per feed (not per VEVENT) matters on a 500-event calendar, and
 * doing it HERE is what keeps parseCalendar's "never throws" guarantee true: an
 * invalid zone becomes an unhealthy parse - change nothing, say so loudly - rather
 * than a RangeError thrown from inside a cron.
 */
function zoneContext(timeZone: string): ZoneContext | null {
  let fmt: Intl.DateTimeFormat;
  try {
    // Explicit parts, not a locale's date format: 'en-CA' happens to render
    // ISO-ish today, but a locale's output is not a contract. formatToParts is.
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return null;
  }
  return {
    timeZone,
    toLocalDate(instant) {
      const parts = fmt.formatToParts(instant);
      const get = (type: string) =>
        parts.find((p) => p.type === type)?.value ?? '';
      return `${get('year')}-${get('month')}-${get('day')}`;
    },
  };
}

/**
 * Extract the PROPERTY-LOCAL `YYYY-MM-DD` calendar date an iCalendar DATE or
 * DATE-TIME value falls on (#145, ADR-0028). Returns null for anything that isn't
 * a leading `YYYYMMDD`, so the caller can skip it.
 *
 * RFC 5545 §3.3.4-5 gives a value four shapes, and only ONE of them needs a zone:
 *
 * | Form    | Example                              | Local date is...          |
 * |---------|--------------------------------------|---------------------------|
 * | DATE    | `;VALUE=DATE:20260801`               | the date itself           |
 * | floating| `20260801T163000`                    | the date part (floating   |
 * |         |                                      | time IS observer-local)   |
 * | TZID    | `;TZID=Asia/Makassar:20260801T163000`| the date part, when TZID  |
 * |         |                                      | is the property's zone    |
 * | **UTC** | `20260801T163000Z`                   | **needs the zone**        |
 *
 * So the first three keep their date part VERBATIM - not approximately right,
 * right by construction - and only a `Z`-suffixed instant is converted. 16:30Z is
 * still 1 Aug in Java and already 2 Aug in Bali; taking the UTC date (what this
 * did before #145) imported the block a night early and shifted BOTH edges of the
 * half-open range, with booking_no_overlap then enforcing the wrong nights.
 *
 * The one case left unhandled: a `TZID` naming a zone that is NOT the property's.
 * Converting it would need the inverse direction - wall-time to instant - which
 * Intl does not offer and where DST gaps and doubled hours live; a general
 * implementation would trade this off-by-one for a subtler one, to serve a case
 * (an OTA publishing a Bali villa's calendar stamped in another zone) more
 * hypothetical than the bug being fixed. It is reported instead, via
 * ParseResult.foreignTimeZones, so the assumption breaks LOUDLY.
 */
function toIsoDate(value: string, zone: ZoneContext): string | null {
  const m = /^\s*(\d{4})(\d{2})(\d{2})/.exec(value);
  if (!m) return null;
  const [, y, mo, d] = m;
  // Reject impossible calendar values (month 00/13, day 00/32) rather than store
  // them - the DB CHECKs would reject the write anyway, better to skip cleanly.
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // A `Z` suffix is the ONLY form that names an instant rather than a local date.
  const utc = /^\s*\d{8}T(\d{2})(\d{2})(\d{2})Z\s*$/.exec(value);
  if (utc) {
    const [, hh, mi, ss] = utc;
    const instant = new Date(
      Date.UTC(Number(y), month - 1, day, Number(hh), Number(mi), Number(ss)),
    );
    // Guard the impossible time components (25:00:00) the date regex can't see.
    if (Number.isNaN(instant.getTime())) return null;
    if (Number(hh) > 23 || Number(mi) > 59 || Number(ss) > 60) return null;
    return zone.toLocalDate(instant);
  }

  return `${y}-${mo}-${d}`;
}

/** `YYYY-MM-DD` + 1 day, UTC-safe (Date.UTC normalises month/year rollover). Used
 * only when a VEVENT has DTSTART but no DTEND - an all-day event is then one day. */
function addOneDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

/** Build a validated ImportedEvent from a VEVENT's collected fields, or null if it
 * is undedupable (no UID) or has no valid half-open range. Never throws. */
function toEvent(
  fields: Map<string, string>,
  zone: ZoneContext,
): ImportedEvent | null {
  const uid = fields.get('UID')?.trim();
  if (!uid) return null;

  const rawStart = fields.get('DTSTART');
  if (rawStart === undefined) return null;
  const start = toIsoDate(rawStart, zone);
  if (!start) return null;

  // DTEND is localized too: a UTC checkout instant crosses the day boundary on
  // the same terms as the arrival, so converting only one edge would stretch or
  // shrink the stay rather than move it.
  const rawEnd = fields.get('DTEND');
  const end = rawEnd === undefined ? addOneDay(start) : toIsoDate(rawEnd, zone);
  if (!end) return null;

  // Half-open, non-empty: a zero-length or inverted range is not a stay (it would
  // fail booking_stay_nonempty anyway). String compare is chronological for ISO.
  if (end <= start) return null;

  return { uid, start, end };
}

/**
 * Parse an iCalendar body into busy spans. Never throws - a bad feed is a
 * `{ ok: false }` value, an EXPECTED outcome the caller acts on (mark the
 * connection `error`, reconcile nothing), never an exception that crashes a cycle.
 */
export function parseCalendar(body: string, timeZone: string): ParseResult {
  // REQUIRED, never defaulted: an optional zone would let a future caller
  // silently reintroduce #145's off-by-one. The zone is not context the parser
  // may decline to apply (ADR-0008's resolvers) - it is missing INPUT, because
  // `20260801T163000Z` has no calendar date until a zone is named.
  const zone = zoneContext(timeZone);
  if (!zone) {
    return { ok: false, error: `Unusable property time zone: ${timeZone}` };
  }

  const lines = unfold(body);

  // The envelope gate (guarantee #1): a whole calendar opens with BEGIN:VCALENDAR
  // and CLOSES with END:VCALENDAR. A truncated download loses the close, so this
  // one check is what stops a fragment from ever reaching reconciliation.
  let sawBegin = false;
  let sawEnd = false;
  for (const line of lines) {
    const t = line.trim().toUpperCase();
    if (t === 'BEGIN:VCALENDAR') sawBegin = true;
    else if (t === 'END:VCALENDAR') sawEnd = true;
  }
  if (!sawBegin || !sawEnd) {
    return { ok: false, error: 'Not a terminated iCalendar (VCALENDAR) feed' };
  }

  const events: ImportedEvent[] = [];
  const foreign = new Set<string>();
  let current: Map<string, string> | null = null;

  for (const line of lines) {
    const parsed = splitLine(line);
    if (!parsed) continue;
    const { name, tzid, value } = parsed;
    const upperValue = value.trim().toUpperCase();

    if (name === 'BEGIN' && upperValue === 'VEVENT') {
      current = new Map();
      continue;
    }
    if (name === 'END' && upperValue === 'VEVENT') {
      if (current) {
        const event = toEvent(current, zone);
        if (event) events.push(event); // else: skip this VEVENT, keep the rest
      }
      current = null;
      continue;
    }
    // Only collect the three fields we trust, and only inside a VEVENT (so a
    // DTSTART in a VTIMEZONE or VALARM can never masquerade as a booking).
    if (current && (name === 'UID' || name === 'DTSTART' || name === 'DTEND')) {
      // A TZID we don't share means this event's date part is local to SOMEWHERE
      // ELSE, and we keep it verbatim anyway (see toIsoDate). Record it so the
      // importer can say so - collected on the ENVELOPE, so ImportedEvent stays
      // the same three trusted strings.
      if (tzid && tzid !== zone.timeZone) foreign.add(tzid);
      // First occurrence wins - a well-formed VEVENT has one of each.
      if (!current.has(name)) current.set(name, value);
    }
  }

  return { ok: true, events, foreignTimeZones: [...foreign] };
}
