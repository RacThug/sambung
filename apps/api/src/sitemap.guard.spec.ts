import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

/**
 * The route sitemap (docs/sitemap.md) cannot silently go stale. This test
 * enumerates the REAL API routes from Nest's own controller metadata - the same
 * reflection `no-body.spec.ts` (#152) walks - and fails if the doc's §3 table
 * omits or invents one. Every controller, every HTTP method; paths are compared
 * without the `/api` global prefix (which lives on the adapter, not the metadata),
 * exactly as the doc lists them. (ADR-0036)
 *
 * The FE half of the same guard is `apps/web/src/sitemap.guard.test.ts`.
 */

const SITEMAP = resolve(__dirname, '../../../docs/sitemap.md');

const METHOD_NAME: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

const trimSlashes = (s: string | undefined): string =>
  (s ?? '').replace(/^\/+/, '').replace(/\/+$/, '');

// controller base + handler sub-path -> one leading-slash path. An empty base
// and empty sub (the root `@Get()`) yield `/`.
const joinPath = (
  base: string | undefined,
  sub: string | undefined,
): string => {
  const parts = [trimSlashes(base), trimSlashes(sub)].filter(Boolean);
  return '/' + parts.join('/');
};

describe('route sitemap - API (docs/sitemap.md §3)', () => {
  let app: INestApplication;
  let discovery: DiscoveryService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    discovery = app.get(DiscoveryService);
  });

  afterAll(async () => {
    await app.close();
  });

  const realRoutes = (): Set<string> => {
    const routes = new Set<string>();
    for (const wrapper of discovery.getControllers()) {
      const controller = wrapper.metatype;
      if (!controller) continue;
      const base = Reflect.getMetadata(PATH_METADATA, controller) as
        | string
        | undefined;

      for (const key of Object.getOwnPropertyNames(controller.prototype)) {
        if (key === 'constructor') continue;
        const handler = (controller.prototype as Record<string, unknown>)[key];
        if (typeof handler !== 'function') continue;

        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          | RequestMethod
          | undefined;
        if (method === undefined) continue;
        const name = METHOD_NAME[method];
        if (!name) continue; // skip ALL / OPTIONS / HEAD - not HTTP verbs we map

        const sub = Reflect.getMetadata(PATH_METADATA, handler) as
          | string
          | undefined;
        routes.add(`${name} ${joinPath(base, sub)}`);
      }
    }
    return routes;
  };

  // The routes documented between the <!-- api-routes:… --> markers: the first
  // cell of every table row that reads as `METHOD /path`. Header/separator rows
  // and the Detail column can't match.
  const documentedRoutes = (): Set<string> => {
    const md = readFileSync(SITEMAP, 'utf8');
    const region = md
      .split('<!-- api-routes:start -->')[1]
      ?.split('<!-- api-routes:end -->')[0];
    if (!region) {
      throw new Error('api-routes markers not found in docs/sitemap.md');
    }

    const routes = new Set<string>();
    for (const line of region.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cell = line.split('|')[1]?.trim().replace(/^`|`$/g, '');
      if (cell && /^(GET|POST|PUT|PATCH|DELETE) \//.test(cell))
        routes.add(cell);
    }
    return routes;
  };

  it('finds routes on both sides (a walk matching nothing proves nothing)', () => {
    // ~55 at the time of writing; the floor guards against the reflection
    // silently returning an empty set after a Nest upgrade or a refactor.
    expect(realRoutes().size).toBeGreaterThanOrEqual(40);
    expect(documentedRoutes().size).toBeGreaterThanOrEqual(40);
  });

  it('documents exactly the real API routes', () => {
    const real = realRoutes();
    const documented = documentedRoutes();
    // missing = a real route absent from the doc; invented = a documented row
    // for a route that no longer exists. Either way, fix docs/sitemap.md §3.
    const missing = [...real].filter((r) => !documented.has(r)).sort();
    const invented = [...documented].filter((r) => !real.has(r)).sort();
    expect({ missing, invented }).toEqual({ missing: [], invented: [] });
  });
});
