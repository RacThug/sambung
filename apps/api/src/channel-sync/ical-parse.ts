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
 */
export type ParseResult =
  | { ok: true; events: ImportedEvent[] }
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

/** Split a content line into its property NAME (upper-cased; params stripped) and
 * raw VALUE. `DTSTART;VALUE=DATE:20260801` → `{ name: 'DTSTART', value: '20260801' }`. */
function splitLine(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const semi = left.indexOf(';');
  const name = (semi === -1 ? left : left.slice(0, semi)).trim().toUpperCase();
  return { name, value: line.slice(colon + 1) };
}

/**
 * Extract a `YYYY-MM-DD` calendar date from an iCalendar DATE or DATE-TIME value
 * (`20260801` or `20260801T140000Z`). Returns null for anything that isn't a leading
 * `YYYYMMDD` so the caller can skip it.
 *
 * **The time is dropped, not converted - a known, accepted limitation (#145).** For
 * the all-day `VALUE=DATE` VEVENTs every OTA we support actually publishes, that is
 * exactly right: there is no time to convert, and half-open dates carry the whole
 * semantics. For a *timed* DTSTART it is a silent off-by-one near the day boundary -
 * `20260801T170000Z` is already 2 Aug in Bali (UTC+8), but yields `2026-08-01` here,
 * shifting the imported block one night early.
 *
 * Not fixed, deliberately (owner's call, 2026-07-21): "property-local" is undefined
 * in this schema - `property` has lat/lng but no timezone - so a correct fix needs a
 * per-property IANA timezone column, and `channelSchema` is a closed set of three
 * OTAs none of which emit timed availability. Revisit with #145 when a channel that
 * does is added; do NOT paper over it with a hardcoded UTC+8, which breaks the first
 * property listed in Java (WIB) or Papua (WIT).
 */
function toIsoDate(value: string): string | null {
  const m = /^\s*(\d{4})(\d{2})(\d{2})/.exec(value);
  if (!m) return null;
  const [, y, mo, d] = m;
  // Reject impossible calendar values (month 00/13, day 00/32) rather than store
  // them - the DB CHECKs would reject the write anyway, better to skip cleanly.
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
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
function toEvent(fields: Map<string, string>): ImportedEvent | null {
  const uid = fields.get('UID')?.trim();
  if (!uid) return null;

  const rawStart = fields.get('DTSTART');
  if (rawStart === undefined) return null;
  const start = toIsoDate(rawStart);
  if (!start) return null;

  const rawEnd = fields.get('DTEND');
  const end = rawEnd === undefined ? addOneDay(start) : toIsoDate(rawEnd);
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
export function parseCalendar(body: string): ParseResult {
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
  let current: Map<string, string> | null = null;

  for (const line of lines) {
    const parsed = splitLine(line);
    if (!parsed) continue;
    const { name, value } = parsed;
    const upperValue = value.trim().toUpperCase();

    if (name === 'BEGIN' && upperValue === 'VEVENT') {
      current = new Map();
      continue;
    }
    if (name === 'END' && upperValue === 'VEVENT') {
      if (current) {
        const event = toEvent(current);
        if (event) events.push(event); // else: skip this VEVENT, keep the rest
      }
      current = null;
      continue;
    }
    // Only collect the three fields we trust, and only inside a VEVENT (so a
    // DTSTART in a VTIMEZONE or VALARM can never masquerade as a booking).
    if (current && (name === 'UID' || name === 'DTSTART' || name === 'DTEND')) {
      // First occurrence wins - a well-formed VEVENT has one of each.
      if (!current.has(name)) current.set(name, value);
    }
  }

  return { ok: true, events };
}
