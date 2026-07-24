import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #188's guard: no display code may slice an instant to a calendar day.
 *
 * The bug was written three times by three authors - `firstDetectedAt` on the
 * conflict card, `expiresAt` on the invite row, and `expiresAt` again in the
 * invite email - and every one was the same nine characters:
 *
 *     formatDate(x.someAt.slice(0, 10))
 *
 * That takes the *UTC* calendar day of a moment, so anything happening before
 * 08:00 in WITA renders as the day before - a third of every day, in the only
 * timezones this product serves. Care has already failed three times, so this
 * fails the build instead. The fix is `formatInstant` (`lib/date.ts`), which
 * resolves the READER's zone and shows the time.
 *
 * Scope is deliberate and its limits are worth stating rather than glossing
 * (an overstated guard is worse than a modest one):
 *
 *   - It reads FEATURE and COMPONENT sources only. `lib/date.ts` legitimately
 *     slices - it is the date library, and the one place that arithmetic belongs.
 *   - It matches the literal string. A novel spelling of the same mistake
 *     (`.substring(0, 10)`, a hand-rolled `.split("T")[0]`) gets past it, so
 *     both are matched too; something genuinely new would not be. This is a
 *     tripwire on the path that has actually been walked, not a type system.
 *
 * Same shape as `sitemap.guard.test.ts` (ADR-0036): enumerate the real files,
 * fail with the exact offenders rather than a bare boolean.
 */

// vitest runs with cwd = apps/web (single-run and under turbo), matching
// sitemap.guard.test.ts.
const SRC = resolve(process.cwd(), "src");
const SCANNED = ["features", "components"];

// Spellings of "take the UTC calendar day of this instant". All three shipped
// bugs used the first; the others are the obvious ways to rewrite it.
const BANNED = [
  { pattern: /\.slice\(\s*0\s*,\s*10\s*\)/, as: ".slice(0, 10)" },
  { pattern: /\.substring\(\s*0\s*,\s*10\s*\)/, as: ".substring(0, 10)" },
  { pattern: /\.split\(\s*["'`]T["'`]\s*\)\s*\[\s*0\s*\]/, as: '.split("T")[0]' },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    // Tests may construct whatever they need to describe a case.
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
    out.push(path);
  }
  return out;
}

describe("instant display", () => {
  it("never slices an instant to a calendar day outside lib/date", () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const file of sourceFiles(join(SRC, dir))) {
        const source = readFileSync(file, "utf8");
        source.split("\n").forEach((line, i) => {
          // Skip comment lines - prose about this rule (including the comment in
          // calendar-model.ts explaining why the arithmetic moved) is not code.
          // A line-start heuristic, not a parser: a trailing `// .slice(0, 10)`
          // on a real statement still trips, which is the safe direction.
          if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
          for (const { pattern, as } of BANNED) {
            if (pattern.test(line)) {
              offenders.push(
                `${relative(SRC, file).replace(/\\/g, "/")}:${i + 1} uses ${as}`,
              );
            }
          }
        });
      }
    }

    // Named, not counted: a failure should say where to look and what to use.
    expect(
      offenders,
      "Display code must not slice a moment to a calendar day - it takes the " +
        "UTC day, which is yesterday for a reader in WIB/WITA/WIT before 08:00 " +
        "(#188). Use formatInstant() from lib/date for a moment, formatDate() " +
        "for a YYYY-MM-DD calendar date, and keep date arithmetic in lib/date.",
    ).toEqual([]);
  });

  it("finds the offenders it is meant to find", () => {
    // The guard's own guard: prove the patterns match the three real bugs as
    // they were written, so an accidental defanging (a typo'd regex, a scan
    // directory that no longer exists) cannot pass silently.
    const shipped = [
      "First seen {formatDate(item.firstDetectedAt.slice(0, 10))}",
      "expires {formatDate(invite.expiresAt.slice(0,10))}",
      "const expires = d.expiresAt.toISOString().substring(0, 10);",
      'const day = instant.split("T")[0];',
    ];
    for (const line of shipped) {
      expect(BANNED.some(({ pattern }) => pattern.test(line))).toBe(true);
    }
    // And that it does not fire on the innocent neighbours it must tolerate.
    for (const line of [
      "dom: Number(date.slice(8, 10)),",
      "return `${fmtDay(from)} – ${fmtDay(addDays(to, -1))} ${from.slice(0, 4)}`;",
    ]) {
      expect(BANNED.some(({ pattern }) => pattern.test(line))).toBe(false);
    }
  });

  it("actually scans a non-trivial number of files", () => {
    // A scan that silently matched nothing (wrong cwd, renamed directory) would
    // pass the first case forever. sitemap.guard.test.ts makes the same bet.
    const count = SCANNED.reduce(
      (n, dir) => n + sourceFiles(join(SRC, dir)).length,
      0,
    );
    expect(count).toBeGreaterThan(30);
  });
});
