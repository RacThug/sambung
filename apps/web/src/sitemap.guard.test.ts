import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { router } from "./router";

/**
 * The route sitemap (docs/sitemap.md) cannot silently go stale. This test
 * enumerates the REAL frontend routes from the TanStack route tree and fails if
 * the doc's §2 table omits or invents one - the guard ADR-0036 makes the point
 * of. The old `page-spec.md §1` map drifted precisely because nothing enforced it.
 *
 * The BE half of the same guard is `apps/api/src/sitemap.guard.spec.ts`.
 */

// vitest runs with cwd = apps/web (both single-run and under turbo), so the repo
// root is two levels up. import.meta.url is not a file:// URL in this setup.
const SITEMAP = resolve(process.cwd(), "../../docs/sitemap.md");

// Strip a trailing slash except on the bare root, so an index route (`/app/`)
// and its layout route (`/app`) collapse to the one route a reader navigates.
function normalize(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

// Every real FE route id, minus TanStack's synthetic `__root__` layout node -
// the one deliberate exclusion (it is not a navigable URL).
function realRoutes(): Set<string> {
  const ids = Object.keys(router.routesById).filter((id) => id !== "__root__");
  return new Set(ids.map(normalize));
}

// The routes documented between the <!-- fe-routes:… --> markers: the first
// cell of every table row that reads as a path. Pointer/purpose columns can't
// match (they don't start with `/`), and header/separator rows are skipped.
function documentedRoutes(): Set<string> {
  const md = readFileSync(SITEMAP, "utf8");
  const region = md
    .split("<!-- fe-routes:start -->")[1]
    ?.split("<!-- fe-routes:end -->")[0];
  if (!region) throw new Error("fe-routes markers not found in docs/sitemap.md");

  const routes = new Set<string>();
  for (const line of region.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cell = line.split("|")[1]?.trim().replace(/^`|`$/g, "");
    if (cell && /^\/[\w$/:.-]*$/.test(cell)) routes.add(normalize(cell));
  }
  return routes;
}

describe("route sitemap - FE (docs/sitemap.md §2)", () => {
  it("finds routes on both sides (a walk matching nothing proves nothing)", () => {
    expect(realRoutes().size).toBeGreaterThanOrEqual(10);
    expect(documentedRoutes().size).toBeGreaterThanOrEqual(10);
  });

  it("documents exactly the real frontend routes", () => {
    const real = realRoutes();
    const documented = documentedRoutes();
    // missing = a real route absent from the doc; invented = a documented row
    // for a route that no longer exists. Either way, fix docs/sitemap.md §2.
    const missing = [...real].filter((r) => !documented.has(r)).sort();
    const invented = [...documented].filter((r) => !real.has(r)).sort();
    expect({ missing, invented }).toEqual({ missing: [], invented: [] });
  });
});
