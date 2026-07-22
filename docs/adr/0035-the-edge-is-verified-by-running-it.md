# ADR-0035: The edge is verified by running it, not by asserting its config

- **Date**: 2026-07-22
- **Status**: Accepted
- **Issue**: [#60](https://github.com/RacThug/sambung/issues/60) (AC 4)
- **Related**: [ADR-0019](0019-og-tags-for-crawlers-at-the-edge.md) (the OG stub at the
  edge), [ADR-0029](0029-a-cutover-is-verified-by-a-probe.md) (the same instrument shape,
  one layer down), [#127](https://github.com/RacThug/sambung/issues/127) (the canonical
  origin)

## Context

`deploy/Caddyfile` is committed, reviewed, load-bearing, and **executed by nothing**. It
says so about itself. The whole of SEO tier 2 rides on it: a link-preview crawler is
recognised by user agent, its request for `/p/:slug` is rewritten to the API's OG stub, and
everyone else gets the SPA.

The existing guard, `property-og.spec.ts`, reads the file as **text** and asserts the
user-agent regex is narrow. That is worth having - a too-broad match is the regression that
actually recurs, and it would serve humans a redirect page while cloaking a search engine.
But a string assertion cannot tell you that the rewrite fires, that the path regex is
anchored, that the SPA fallback still wins, or that the card's image is one a stranger's
phone can load. **Committed and reviewed is not the same as verified.**

#60 AC 4 asked for the missing evidence in the only form available at the time: point a
real crawler at a deployed origin and look at the card. That reads as "deploy first", which
is why it was deferred twice. It is also a poor instrument for most of what it would catch:
a crawler returns one blurry verdict, caches it for days, and never says which link broke.

Two facts, both measured rather than assumed, changed the shape of the answer:

- A Cloudflare **quick tunnel** gives a public https origin with no account, no card and no
  DNS, so "needs a deployed origin" was never quite true.
- Node's `fetch` (undici) **silently drops a `Host` header**. It throws nothing and sends
  the real authority. A forged-`Host` probe written with `fetch` would report "the
  canonical held firm" against an origin that never saw the forgery.

## Decision

**Verify the edge by running it and measuring what it does.**

1. **An opt-in compose profile runs the real file.** `docker compose --profile edge up -d`
   starts Caddy with `deploy/Caddyfile` **bind-mounted**, never copied - a copy would drift
   from what ships, which is the failure ADR-0019 exists to prevent. Default `docker compose
   up -d` behaviour is unchanged.
2. **`pnpm --filter api og:doctor [baseUrl] [slug]`** probes whatever origin it is given:
   routing (crawler → stub, human → SPA, Googlebot → SPA, LINE's in-app browser → SPA,
   anchoring, trailing slash, unknown slug → 404), the card (its tags equal
   `buildPropertyOgTags` over the **live** JSON endpoint, its image is fetchable
   anonymously), and the canonical.
3. **The target is an argument, never app config.** Unlike `storage-doctor`, this script
   does not load `.env`. It has to be pointable at an origin that disagrees with what the
   app claims, or point 4 is impossible - and a config file the script can read is not
   evidence about the process answering on a tunnel or a VPS.
4. **The canonical is tested behaviourally.** A forged `Host` must not move `og:url`. Both
   outcomes are a pass - the edge may refuse a foreign `Host` outright, or serve while
   deriving `og:url` from trusted config - and only "the canonical followed my forgery" is a
   failure. Written over `node:http`, because `fetch` would make this check vacuous.
5. **Severity follows what the answer means** (ADR-0029's rule). An `og:url` origin mismatch
   is a *finding* on loopback (a dev artefact: Caddy serves :80, `WEB_BASE_URL` names Vite
   on :5173) and a *failure* on a public origin (there it is the #127 defect). An image on a
   loopback host is a finding that names its own consequence: a text-only card for every
   remote crawler.
6. **Two tunnels for the manual pass, not one.** The site and the photos get separate quick
   tunnels. That is the production shape - Caddy serves the app, R2 serves the photos - so a
   single-origin tunnel would be testing an arrangement that never ships.
7. **A script, not a suite.** It stays out of `pnpm test`.

## Consequences

- The Caddyfile's behaviour is measurable for the first time, on any origin: localhost, a
  tunnel, or a real deploy. The same instrument serves all three.
- #60 AC 4 becomes doable today. Everything mechanical is proven green first, so if a card
  still looks wrong the fault is the crawler's rendering, not the plumbing.
- **The edge is unguarded between deliberate runs, and the runbook says so.** Buying
  continuous coverage would mean a suite that needs Docker, a built SPA, and
  container-to-host networking, in a repo with no cloud CI that has just spent effort
  removing flakiness. A flaky suite gets skipped and then lies about coverage; an honest gap
  does not. `property-og.spec.ts` remains the cheap always-on guard.
- The probe was **self-verified red before being trusted green**: against a purpose-built
  broken edge it caught all eight seeded misconfigurations and exited non-zero, and both
  precondition paths (nothing listening, an origin that is not the SPA) report the
  actionable diagnosis rather than a mystery failure.

## Alternatives considered

- **Fold this into ADR-0029.** Same instrument shape, and #152 set a precedent for
  amend-in-place. Rejected: ADR-0029's claim is that a *storage backend's* guarantees are
  someone else's to keep. This one names a different category - **committed config that
  nothing executes** - which recurs (`docker-compose.yml`, `.env.example`), and it has to
  record three decisions ADR-0029 does not contain (points 4, 6 and 7).
- **An integration test that spins Caddy on every push.** Real continuous coverage; see
  point 7 for why the trade lands the other way here.
- **A `/photos/*` route in the committed Caddyfile**, so one tunnel serves both. It has
  genuine merit - it would make ADR-0029's documented Garage-on-VPS fallback real - but it
  edits production config to run an errand, and widens a verification task into a storage
  topology decision. That deserves its own issue.
- **Deploy the VPS and verify for real.** Still the gold standard, and still worth doing at
  deploy time. It is not a prerequisite for knowing the chain holds.
