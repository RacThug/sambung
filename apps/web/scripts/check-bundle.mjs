// Bundle-size guard for the public funnel entry (#125, ADR-0023).
//
// Reads the Vite build manifest (dist/.vite/manifest.json) and asserts two
// things about what a guest loads on the /p/:slug property page:
//
//   1. STRUCTURE - the property route's initial JS must NOT statically pull the
//      dashboard chunks or the phone chunk (libphonenumber-js). This is the real
//      guarantee behind the code-split; it holds regardless of byte counts.
//   2. SIZE - the gzipped total of that initial JS must stay under a budget, so
//      the funnel entry cannot silently regrow back toward the monolith.
//
// Node built-ins only (fs, zlib, path, url) - no dependency, nothing to install.
// Run AFTER `vite build`: `node scripts/check-bundle.mjs` (also `pnpm check:bundle`).

import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(webDir, "dist");
const manifestPath = join(distDir, ".vite", "manifest.json");

// The gzipped budget for the property page's initial JS. Current measured size is
// ~161 kB; the pre-split monolith was ~234 kB. This budget sits between them, so
// re-merging the dashboard or libphonenumber back in (each tens of kB) fails the
// build, while ordinary feature growth on the funnel has headroom.
const BUDGET_GZIP_KB = 185;

// The manifest keys that define the property route's initial load, and the keys
// that must never be reachable from it via STATIC imports.
const ENTRY_KEY = "index.html";
const PROPERTY_ROUTE_KEY = "src/features/public-booking/property-page.tsx";
const PHONE_KEY = "src/features/public-booking/phone.ts"; // carries libphonenumber-js
const CHECKOUT_ROUTE_KEY = "src/features/public-booking/checkout-page.tsx";
const DASHBOARD_ROUTE_KEYS = [
  "src/features/dashboard/app-shell.tsx",
  "src/features/calendar/calendar-page.tsx",
  "src/features/reservations/reservations-page.tsx",
  "src/features/properties/properties-page.tsx",
  "src/features/properties/property-edit-page.tsx",
  "src/features/bookings/booking-detail-page.tsx",
  "src/features/payments/lapsed-payments-page.tsx",
];

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  console.error(
    `check-bundle: no manifest at ${manifestPath}. Run \`pnpm --filter web build\` first.`,
  );
  process.exit(1);
}

/** Fail loudly if a key we reason about disappeared (a rename must update this). */
function requireKey(key) {
  if (!manifest[key]) {
    console.error(
      `check-bundle: manifest key "${key}" is missing - did a route file move? Update scripts/check-bundle.mjs.`,
    );
    process.exit(1);
  }
}
[ENTRY_KEY, PROPERTY_ROUTE_KEY, PHONE_KEY, CHECKOUT_ROUTE_KEY].forEach(requireKey);

/** Transitive closure over STATIC imports only (dynamicImports are separate
 * chunks the browser fetches on demand - exactly what we want excluded). */
function staticClosure(startKeys) {
  const seen = new Set();
  const stack = [...startKeys];
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key) || !manifest[key]) continue;
    seen.add(key);
    for (const imp of manifest[key].imports ?? []) stack.push(imp);
  }
  return seen;
}

const propertyClosure = staticClosure([ENTRY_KEY, PROPERTY_ROUTE_KEY]);

// --- 1. STRUCTURE ---------------------------------------------------------
const leaks = [];
if (propertyClosure.has(PHONE_KEY)) leaks.push("phone.ts (libphonenumber-js)");
if (propertyClosure.has(CHECKOUT_ROUTE_KEY)) leaks.push("checkout-page.tsx");
for (const key of DASHBOARD_ROUTE_KEYS) {
  if (propertyClosure.has(key)) leaks.push(key);
}

// libphonenumber must be deferred to the checkout phone step: the phone chunk is
// a DYNAMIC import of checkout, never a static one.
const checkoutDynamic = manifest[CHECKOUT_ROUTE_KEY].dynamicImports ?? [];
const phoneIsLazy = checkoutDynamic.includes(PHONE_KEY);

// --- 2. SIZE --------------------------------------------------------------
const jsFiles = new Set();
for (const key of propertyClosure) {
  const file = manifest[key].file;
  if (file && file.endsWith(".js")) jsFiles.add(file);
}
let rawBytes = 0;
let gzipBytes = 0;
for (const file of jsFiles) {
  const buf = readFileSync(join(distDir, file));
  rawBytes += statSync(join(distDir, file)).size;
  gzipBytes += gzipSync(buf).length;
}
const gzipKb = gzipBytes / 1024;

// --- Report ---------------------------------------------------------------
console.log("Public funnel entry (/p/:slug) initial JS:");
console.log(`  chunks: ${jsFiles.size}`);
console.log(`  raw:    ${(rawBytes / 1024).toFixed(1)} kB`);
console.log(`  gzip:   ${gzipKb.toFixed(1)} kB   (budget ${BUDGET_GZIP_KB} kB)`);
console.log(
  `  libphonenumber deferred to checkout phone step: ${phoneIsLazy ? "yes" : "NO"}`,
);

const failures = [];
if (leaks.length) {
  failures.push(
    `property page statically pulls chunks it must not: ${leaks.join(", ")}`,
  );
}
if (!phoneIsLazy) {
  failures.push(
    "phone.ts is not a dynamic import of checkout - libphonenumber is no longer lazy",
  );
}
if (gzipKb > BUDGET_GZIP_KB) {
  failures.push(
    `funnel entry ${gzipKb.toFixed(1)} kB gzip exceeds budget ${BUDGET_GZIP_KB} kB`,
  );
}

if (failures.length) {
  console.error("\ncheck-bundle FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\ncheck-bundle PASSED");
