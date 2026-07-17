/**
 * Slug: a Property's permanent public address (api-spec §4.7, ADR-0004).
 *
 * Minted once, at create, from the name - and never again. A rename does NOT
 * move it. The slug is an address, not a label: it is pasted into OTA profiles,
 * forwarded on WhatsApp, printed on cards, and every one of those breaks
 * silently if an edit the owner thinks is cosmetic changes the URL.
 *
 * Globally unique, because `/p/:slug` has no tenant in the path - the slug IS
 * how a request finds its tenant (ADR-0003). Uniqueness is the DB's job: the
 * `property_slug_key` index is the only check, since RLS hides the rows an
 * app-level pre-check would need to see. See properties.service for the mint.
 */

/** Max slug length before any collision suffix. `name` allows 160. */
const MAX_BASE_LENGTH = 60;

/** Suffix alphabet: no vowels (no accidental words), no 0/1/l/o (no misreads). */
const TOKEN_ALPHABET = "23456789bcdfghjkmnpqrstvwxyz";
const TOKEN_LENGTH = 5;

/**
 * The shape every slug must have, and the shape the `property_slug_format`
 * CHECK mirrors: lowercase alphanumerics in `-`-separated runs, no leading,
 * trailing, or doubled `-`.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Random token, for a collision suffix or an un-slugifiable name.
 *
 * Not sequential (`-2`, `-3`): finding the next number means reading the rows
 * already taken, which are exactly the rows RLS hides from us - and a sequence
 * leaks how many properties share a name across tenants.
 */
function randomToken(): string {
  let out = "";
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    out += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  }
  return out;
}

/**
 * Name -> slug base. Deterministic, except for the fallback below.
 *
 * NFKD + stripping combining marks handles the Latin-1 case without a
 * dependency: "Café Lumbung" -> "cafe-lumbung". It cannot help 中文, which
 * decomposes to nothing ASCII - and 中文 is a first-class language here
 * (FR-I18N-1), so "乌布丛林别墅" is a name an owner will really type.
 *
 * When nothing survives, we do NOT transliterate. Pinyin ("wu-bu-cong-lin-bie-shu")
 * is prettier only to someone who doesn't read the language it came from, and it
 * costs a dependency to produce. An opaque-but-working `property-k3f9x` is the
 * honest answer; the page it opens is fully localized either way.
 */
export function slugifyName(name: string): string {
  const base = name
    .normalize("NFKD")
    // Strip the combining marks NFKD leaves behind (é -> e + U+0301 -> e).
    // Escaped, not literal: literal combining marks are invisible in source and
    // an editor or a stray keystroke can silently eat them.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BASE_LENGTH)
    // slice() can leave a trailing `-` behind; SLUG_PATTERN forbids one.
    .replace(/-+$/g, "");

  return base.length > 0 ? base : `property-${randomToken()}`;
}

/**
 * The candidates to try, in order, for one create: the bare slug first, then
 * suffixed retries. Consumed by the mint loop, which stops at the first one the
 * unique index accepts (properties.service).
 *
 * Five attempts is not a real bound - with ~17M tokens per base name, reaching
 * attempt three already means something is wrong. It exists so a bug cannot spin
 * forever; exhausting it is a 500, deliberately.
 */
export function* slugCandidates(name: string): Generator<string> {
  const base = slugifyName(name);
  yield base;
  for (let i = 0; i < 4; i++) {
    yield `${base}-${randomToken()}`;
  }
}
