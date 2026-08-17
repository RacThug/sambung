import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * MIG-01 (EARS docs/spec/tenant-payments.md): the app reads NO platform-wide
 * Midtrans key - `MIDTRANS_SERVER_KEY` is seed-only (packages/db), where it
 * plants a demo credential. This walks apps/api/src and fails on any READ of
 * the variable (comments may still mention it by name - the ban is on the
 * value flowing back in, not on documenting its absence).
 *
 * The ADR-0036 family: enumerate reality rather than trust a review to notice
 * a `config.get('MIDTRANS_SERVER_KEY')` quietly returning.
 */
const SRC = join(__dirname, '..');

// READS only - a comment may still name the variable (documenting its absence
// is fine; the value flowing back in is not). Covers the codebase's idioms:
// process.env / env-object access (dot and bracket) and ConfigService's
// get / getOrThrow, generic or not.
const READ_PATTERNS = [
  /process\.env\.MIDTRANS_SERVER_KEY/,
  /\benv\.MIDTRANS_SERVER_KEY/,
  /\[['"]MIDTRANS_SERVER_KEY['"]\]/,
  /get(OrThrow)?(<[^>]*>)?\(\s*['"]MIDTRANS_SERVER_KEY['"]/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('no platform-wide Midtrans key (MIG-01)', () => {
  it('nothing in apps/api/src reads MIDTRANS_SERVER_KEY', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === __filename) continue; // this guard names the patterns itself
      const content = readFileSync(file, 'utf8');
      if (READ_PATTERNS.some((p) => p.test(content))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
