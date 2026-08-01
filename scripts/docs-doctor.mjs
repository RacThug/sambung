#!/usr/bin/env node
/**
 * docs-doctor - checks `docs/pages/*.md` against the codebase.
 *
 * The route map is enforced against the router (ADR-0036) because an unenforced
 * discipline is the mechanism that produced the drift it was written to fix. Page
 * specs are the same shape of promise one layer down: they name schemas, routes and
 * endpoints, and every one of those names can rot without anyone noticing. This is
 * the guard that makes them rot LOUDLY.
 *
 * Six checks, each failing with the file:line of the offending row (ADR-0038).
 *
 * Deliberately zero dependencies and plain Node ESM, matching
 * `apps/web/scripts/check-bundle.mjs` rather than the `apps/api/scripts/*.ts`
 * doctors: those need the api workspace's env and `tsx`, while this reads four
 * plain-text trees and must run from the repo root in a pre-push hook.
 *
 *   pnpm docs:doctor
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PAGES_DIR = join(ROOT, "docs", "pages");
const SHARED_SRC = join(ROOT, "packages", "shared", "src");
const WEB_FEATURES = join(ROOT, "apps", "web", "src", "features");
const SITEMAP = join(ROOT, "docs", "sitemap.md");
const ALLOWLIST = join(PAGES_DIR, "_schema-allowlist.md");

/** Files in docs/pages that are shared documents, not page specs. `_`-prefixed is
 * the README's own convention; the other two are named because they would each
 * break a check in a different, silent way - `_template.md` carries a specimen
 * `route:` that no router has, and MIGRATION-REPORT.md names every unreferenced
 * schema in prose, which would satisfy check 5 for all of them. */
const NOT_A_PAGE_SPEC = new Set(["README.md", "MIGRATION-REPORT.md"]);

/** Schema-column values that mean "no schema", not "a schema named this". */
const SCHEMA_SENTINELS = new Set(["none", "none found", "-", "new", "n/a", ""]);

const findings = [];
const note = (group, location, message) =>
  findings.push({ group, location, message });

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const rel = (p) => relative(ROOT, p).split("\\").join("/");

function listFiles(dir, filter, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listFiles(full, filter, out);
    else if (filter(entry)) out.push(full);
  }
  return out;
}

/** Strip the markdown a cell may carry, without touching identifier characters
 * (`_` and digits are part of names, so only backticks, emphasis and links go). */
function clean(cell) {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
}

/** Front matter as a flat map. Not YAML - the frontmatter here is five scalar keys
 * by contract (see `_template.md`), and a YAML dependency to read five lines would
 * be the heavier answer to the smaller problem. */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

/**
 * Every markdown table in a document whose header contains all of `columns`,
 * returned as rows of cells plus the 1-based line number of each row - which is
 * the whole point: a finding has to point at the row a human can open.
 */
function tablesWithColumns(text, columns) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith("|")) continue;
    const header = splitRow(lines[i]).map((c) => clean(c).toLowerCase());
    if (!columns.every((c) => header.includes(c))) continue;
    const index = Object.fromEntries(columns.map((c) => [c, header.indexOf(c)]));
    const rows = [];
    // i+1 is the `|---|` separator; data starts at i+2.
    for (let j = i + 2; j < lines.length; j++) {
      if (!lines[j].trimStart().startsWith("|")) break;
      rows.push({ cells: splitRow(lines[j]), line: j + 1 });
    }
    tables.push({ index, rows });
    i += rows.length + 1;
  }
  return tables;
}

function splitRow(line) {
  const t = line.trim();
  return t.slice(1, t.endsWith("|") ? -1 : undefined).split("|");
}

// ---------------------------------------------------------------------------
// The four sources of truth
// ---------------------------------------------------------------------------

/** Every export of `packages/shared` - the namespace the Schema column names. */
function sharedExports() {
  const names = new Set();
  for (const file of listFiles(SHARED_SRC, (f) => f.endsWith(".ts"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(
      /^export\s+(?:const|function\*?|type|interface|class)\s+([A-Za-z0-9_]+)/gm,
    )) {
      names.add(m[1]);
    }
    // `export { noBodyRequestSchema }` - the one named re-export in the barrel.
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1].split(",")) {
        const name = part.split(/\s+as\s+/).pop().trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

/**
 * The SPA's route-search schemas. URL state is validated by a real zod schema that
 * simply does not live in `packages/shared`, because it is the page's contract with
 * the URL bar rather than with the API - so the Schema column resolves against two
 * namespaces, and a name in neither is still a failure. See ADR-0038's Consequences.
 */
function webSearchExports() {
  const names = new Set();
  for (const file of listFiles(WEB_FEATURES, (f) => f.endsWith("-search.ts"))) {
    for (const m of readFileSync(file, "utf8").matchAll(
      /^export\s+const\s+([A-Za-z0-9_]+)/gm,
    )) {
      names.add(m[1]);
    }
  }
  return names;
}

/**
 * The routes and endpoints, read from `docs/sitemap.md`'s machine-marked sections.
 *
 * This is the ADR-0036 mechanism REUSED, not reimplemented, and the distinction is
 * the load-bearing design decision here. Those two tables are already pinned to
 * `router.routesById` and to Nest's `DiscoveryService` by tests that run in
 * `pnpm test`. Re-deriving routes here would create a THIRD copy of the route list -
 * exactly the drift ADR-0036 exists to kill - and it would need a bundler for the
 * TSX route tree and a booted Nest app for the controllers, in a script that must
 * run in a git hook.
 *
 * The cost is stated rather than hidden: this probe's route and endpoint checks are
 * only as strong as those two guards. If they are skipped, sitemap.md is a
 * hand-written list again and this check inherits that.
 */
function sitemapRoutes() {
  const text = readFileSync(SITEMAP, "utf8");
  const section = (marker) => {
    const m = text.match(
      new RegExp(`<!-- ${marker}:start -->([\\s\\S]*?)<!-- ${marker}:end -->`),
    );
    if (!m) {
      note(
        "(repo)",
        rel(SITEMAP),
        `missing the \`${marker}\` machine markers - the ADR-0036 guard's own anchors are gone`,
      );
      return "";
    }
    return m[1];
  };
  const firstCells = (body) =>
    body
      .split(/\r?\n/)
      .filter((l) => l.trimStart().startsWith("|"))
      .map((l) => clean(splitRow(l)[0]))
      .filter(Boolean);

  const fe = new Set(firstCells(section("fe-routes")).filter((c) => c.startsWith("/")));
  const api = new Set();
  for (const cell of firstCells(section("api-routes"))) {
    const m = cell.match(/^(GET|POST|PATCH|PUT|DELETE)\s+(\S+)$/);
    if (m) api.add(`${m[1]} ${m[2]}`);
  }
  return { fe, api };
}

/** The allowlist: accepted absences, each with a reason. Two tables, one shape. */
function allowlist() {
  let text;
  try {
    text = readFileSync(ALLOWLIST, "utf8");
  } catch {
    note("(repo)", rel(ALLOWLIST), "allowlist file is missing");
    return { schemas: new Map(), routes: new Map() };
  }
  const read = (col) => {
    const map = new Map();
    for (const table of tablesWithColumns(text, [col, "reason"])) {
      for (const { cells } of table.rows) {
        const key = clean(cells[table.index[col]] ?? "");
        const reason = clean(cells[table.index.reason] ?? "");
        if (key) map.set(key, reason);
      }
    }
    return map;
  };
  return { schemas: read("schema"), routes: read("route") };
}

// ---------------------------------------------------------------------------
// The page specs
// ---------------------------------------------------------------------------

const DATA_COLUMNS = [
  "region",
  "ui element",
  "field",
  "schema",
  "endpoint",
  "computed in",
  "source",
];

function loadPageSpecs() {
  const specs = [];
  for (const file of readdirSync(PAGES_DIR)) {
    if (!file.endsWith(".md")) continue;
    if (file.startsWith("_") || NOT_A_PAGE_SPEC.has(file)) continue;

    const path = join(PAGES_DIR, file);
    const text = readFileSync(path, "utf8");
    const fm = frontmatter(text);
    if (!fm || !fm.route) {
      note(
        file,
        `${rel(path)}:1`,
        "no frontmatter `route:` - a page spec needs one, and a shared document belongs behind a `_` prefix",
      );
      continue;
    }
    specs.push({
      name: file,
      path,
      text,
      route: fm.route,
      status: (fm.status || "draft").toLowerCase(),
      tables: tablesWithColumns(text, DATA_COLUMNS),
    });
  }
  return specs;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const shared = sharedExports();
const webSearch = webSearchExports();
const known = new Set([...shared, ...webSearch]);
const { fe: sitemapFe, api: sitemapApi } = sitemapRoutes();
const allow = allowlist();
const specs = loadPageSpecs();

const citedSchemas = new Set();

for (const spec of specs) {
  const where = (line) => `${rel(spec.path)}:${line}`;

  // -- 2. the frontmatter route exists in the router (via sitemap, see above) --
  if (!sitemapFe.has(spec.route)) {
    note(
      spec.name,
      `${rel(spec.path)}:2`,
      `route \`${spec.route}\` is not in docs/sitemap.md §2, so it is not a route the router serves`,
    );
  }

  if (spec.tables.length === 0) {
    note(
      spec.name,
      `${rel(spec.path)}:1`,
      "no data-requirements table (the seven-column table from `_template.md` §3)",
    );
  }

  for (const table of spec.tables) {
    for (const { cells, line } of table.rows) {
      const cell = (col) => clean(cells[table.index[col]] ?? "");

      // -- 1. every Schema value is a real export --
      const schemaCell = cell("schema");
      if (!SCHEMA_SENTINELS.has(schemaCell.toLowerCase())) {
        for (const name of schemaCell.split(/[\s,/+·]+/).filter(Boolean)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
          if (known.has(name)) {
            citedSchemas.add(name);
          } else {
            note(
              spec.name,
              where(line),
              `unknown export \`${name}\` in the Schema column (not in packages/shared, not a route-search schema)`,
            );
          }
        }
      }

      // -- 3. every Endpoint value exists in apps/api (via sitemap, see above) --
      const endpointCell = cell("endpoint");
      for (const m of endpointCell.matchAll(
        /\b(GET|POST|PATCH|PUT|DELETE)\s+(\/[^\s|]*)/g,
      )) {
        const route = `${m[1]} ${m[2].replace(/[.,;]$/, "")}`;
        if (!sitemapApi.has(route)) {
          note(
            spec.name,
            where(line),
            `endpoint \`${route}\` is not in docs/sitemap.md §3, so no controller serves it`,
          );
        }
      }

      // -- 6. [TBD] is only allowed while the spec is a draft --
      const source = cell("source").toLowerCase();
      if (source.includes("[tbd]") && spec.status !== "draft") {
        note(
          spec.name,
          where(line),
          `Source is [TBD] but status is \`${spec.status}\` - TBD is allowed only while status is \`draft\``,
        );
      }
      if (source && !/\[(spec|code|tbd)\]/.test(source)) {
        note(
          spec.name,
          where(line),
          `Source is \`${source || "(empty)"}\` - every row must carry [spec], [code] or [TBD]`,
        );
      }
    }
  }
}

// -- 4. page specs and the sitemap agree in both directions --
const specRoutes = new Map(specs.map((s) => [s.route, s.name]));
for (const route of sitemapFe) {
  if (specRoutes.has(route)) continue;
  if (allow.routes.has(route)) {
    if (!allow.routes.get(route)) {
      note("(repo)", rel(ALLOWLIST), `route \`${route}\` is allowlisted with no reason`);
    }
    continue;
  }
  note(
    "(repo)",
    rel(SITEMAP),
    `route \`${route}\` has no page spec in docs/pages/ and is not allowlisted`,
  );
}
for (const [route, name] of specRoutes) {
  if (allow.routes.has(route)) {
    note(
      "(repo)",
      rel(ALLOWLIST),
      `route \`${route}\` is allowlisted as having no page spec, but ${name} specs it`,
    );
  }
}

// -- 5. every shared schema is cited by a page spec, or allowlisted with a reason --
// Scoped to `*Schema` exports: the `z.infer` type twin of every schema is also an
// export, and requiring both would fail 58 rows for a naming convention rather than
// a gap (MIGRATION-REPORT.md §6a). The limit is real and stated in ADR-0038.
const specTexts = specs.map((s) => s.text);
const isCited = (name) =>
  citedSchemas.has(name) ||
  specTexts.some((t) => new RegExp(`\\b${name}\\b`).test(t));

for (const name of [...shared].filter((n) => n.endsWith("Schema")).sort()) {
  if (isCited(name)) {
    if (allow.schemas.has(name)) {
      note(
        "(repo)",
        rel(ALLOWLIST),
        `\`${name}\` is allowlisted as having no page, but a page spec cites it - remove the entry`,
      );
    }
    continue;
  }
  if (allow.schemas.has(name)) {
    if (!allow.schemas.get(name)) {
      note("(repo)", rel(ALLOWLIST), `\`${name}\` is allowlisted with no reason`);
    }
    continue;
  }
  note(
    "(repo)",
    rel(SHARED_SRC),
    `\`${name}\` is exported by packages/shared but no page spec cites it, and it is not allowlisted`,
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pageCount = specs.length;
const rowCount = specs.reduce(
  (n, s) => n + s.tables.reduce((m, t) => m + t.rows.length, 0),
  0,
);

if (findings.length === 0) {
  console.log(
    `✓ docs-doctor: ${pageCount} page specs, ${rowCount} data rows, ` +
      `${[...shared].filter((n) => n.endsWith("Schema")).length} shared schemas - all clean.`,
  );
  process.exit(0);
}

console.error(`✗ docs-doctor: ${findings.length} problem(s)\n`);
const groups = new Map();
for (const f of findings) {
  if (!groups.has(f.group)) groups.set(f.group, []);
  groups.get(f.group).push(f);
}
for (const [group, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
  console.error(`  ${group}`);
  for (const f of list) console.error(`    ${f.location}  ${f.message}`);
  console.error("");
}
console.error(
  "docs-doctor checks page specs against the code (ADR-0038). It cannot tell you\n" +
    "whether a rule BELONGS in the backend - that judgement stays yours.",
);
process.exit(1);
