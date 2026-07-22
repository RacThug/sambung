# Link-preview verification

How to prove that a `/p/:slug` link, pasted into WhatsApp, renders a real card: the
property's name, its description, and its hero photo.

This is the runbook for **#60 AC 4** and the companion to
[`docs/r2-cutover.md`](r2-cutover.md). Same shape, same reason: an instrument for
everything measurable, a written procedure for the part that is irreducibly manual.

> Context: [ADR-0019](adr/0019-og-tags-for-crawlers-at-the-edge.md) (why crawlers get a
> stub at all), [ADR-0035](adr/0035-the-edge-is-verified-by-running-it.md) (why this is a
> probe rather than a test).

---

## Why there is an instrument at all

`deploy/Caddyfile` carries the comment *"NOT executed by any test"*, and that is exactly
true. `property-og.spec.ts` reads the file as **text** and asserts the crawler user-agent
regex is narrow. That is a real guard against the regression that actually recurs
(someone broadening the match), and it proves nothing about behaviour: not that the
rewrite fires, not that a human still gets the app, not that the card's image is one a
stranger's phone can load.

A real crawler is a poor instrument for those. It returns one blurry verdict, caches it
for days, and never tells you which link in the chain broke. So the chain is measured
first, and the crawler is asked only the question only it can answer: *does this card
look right to a human?*

---

## 1. Local: measure the chain

```bash
docker compose up -d                        # db + garage
pnpm --filter @sambung/db db:reset          # seed
pnpm --filter api dev                       # API on :3000
pnpm --filter @sambung/web build            # Caddy's file_server needs a real dist
docker compose --profile edge up -d         # Caddy on :80, the committed Caddyfile
pnpm --filter api og:doctor
```

`og:doctor` boots no app, opens no database connection, and only ever issues GETs. It
takes the origin as an argument, not from config, precisely so it can be pointed at an
origin that **disagrees** with what the app claims (that is what makes the forged-`Host`
probe possible).

```
pnpm --filter api og:doctor [baseUrl] [slug]     # defaults: http://localhost, seminyak-beach-villa
```

### The localhost baseline

Measured 2026-07-22 against the compose edge, so a future run has something to diff
against:

| Probe | Result |
|---|---|
| edge reachable | PASS - SPA shell at `/` |
| crawler gets the stub | PASS |
| human gets the SPA | PASS |
| Googlebot gets the SPA | PASS - not cloaking |
| LINE in-app browser gets the SPA | PASS - the #127 regression, now tested by behaviour |
| `line-poker` gets the stub | PASS |
| trailing slash gets the stub | PASS |
| deeper path (`/book`) gets the SPA | PASS - the path regex is anchored |
| unknown slug is a 404, not a stub | PASS - ADR-0006 |
| api still proxies | PASS |
| card matches the live page | PASS - identical to `buildPropertyOgTags` over the live JSON |
| og:image is fetchable | PASS - HTTP 200, `image/png`, anonymous |
| og:image is reachable by a stranger | **NOTE** - `sambung-photos.web.garage.localhost` |
| og:image weight | PASS - 33 KB |
| og:url points at the probed origin | **NOTE** - `WEB_BASE_URL` names Vite on :5173 |
| a forged `Host` cannot move og:url | PASS - held at the configured base |

**14 passed, 0 failed, 2 findings.** Both findings are expected locally and both are
fixed by step 2. Findings are measurements, not blockers.

---

## 2. Public: two quick tunnels

The manual pass needs a public https origin. It does **not** need a VPS, a domain, or an
account: a Cloudflare *quick tunnel* is anonymous and free, and an ephemeral hostname is
an advantage here, because these crawlers cache by URL and a fresh one is a guaranteed
cache miss.

**Two** tunnels, not one, and that is the prod shape rather than a workaround: in
production the app is served by Caddy and photos are served by R2, from different
origins. A single-origin tunnel would be testing an arrangement that never ships.

```bash
# Terminal A - the site
docker run --rm -it --add-host=host.docker.internal:host-gateway \
  cloudflare/cloudflared:latest tunnel --url http://host.docker.internal:80

# Terminal B - photos (Garage routes buckets by Host, so the header is rewritten;
# --http-host-header is a real cloudflared flag, verified against the binary)
docker run --rm -it --add-host=host.docker.internal:host-gateway \
  cloudflare/cloudflared:latest tunnel --url http://host.docker.internal:3902 \
  --http-host-header sambung-photos.web.garage.localhost
```

Each prints a `https://<random>.trycloudflare.com`. Then, in `apps/api/.env`:

```ini
WEB_BASE_URL="https://<site-tunnel>"              # og:url / canonical (#127)
STORAGE_PUBLIC_BASE_URL="https://<photo-tunnel>"  # where og:image points
```

Restart the API. No re-seed and no re-upload: photo URLs are composed at read time from
the base (`storage.service.ts`), so the stored keys are untouched.

Re-measure against the public origin:

```bash
pnpm --filter api og:doctor https://<site-tunnel>
```

Expect **0 failures and 0 findings**. Two probes change severity on a public target, on
purpose:

- **og:url mismatch becomes a FAILURE.** On localhost it is a dev artefact (Caddy serves
  :80 while `WEB_BASE_URL` names Vite on :5173). On a public origin it is the #127 defect:
  a card attributed to somewhere else.
- **A loopback og:image stays a finding but now matters.** It is the difference between a
  card with a villa photo and a card with a grey box, and it is invisible from the machine
  running the probe, which can resolve the host perfectly well.

On a clean public run the probe prints the two URLs to paste into step 3.

---

## 3. The manual pass (the part no instrument can do)

Only now, with every mechanical link green, ask the crawlers. If a card still looks wrong
at this point, the fault is in the crawler's rendering, not in the plumbing, and that is
worth knowing before you start guessing.

1. **Facebook Sharing Debugger** - <https://developers.facebook.com/tools/debug/>. Paste
   `https://<site-tunnel>/p/seminyak-beach-villa`. Press **Scrape Again**: these crawlers
   cache aggressively, and a stale scrape is the single most common false alarm. Confirm
   the title, the description, and the image preview.
2. **A real WhatsApp share** - forward the same link into any chat and confirm the rich
   card appears before you send.
3. **A real LINE share** - same link, same check. LINE's preview scraper is
   `facebookexternalhit/1.1;line-poker/1.0` (#127); its in-app browser is a human and must
   get the app, which probe 5 already proved.

Tear down by stopping both tunnels and reverting the two `.env` values.

---

## What this does not cover

Stated plainly, because an overstated guarantee is worse than a modest one.

- **The edge is unguarded between deliberate runs.** This is a script, not a suite: it
  needs Docker, a built SPA, and container-to-host networking, and `pnpm test` runs on
  whatever laptop is at hand with no cloud CI. The always-on guard remains
  `property-og.spec.ts`'s narrowness assertion. Run this before a deploy and at demo prep.
- **Only the compose edge is exercised locally.** A production Caddy also terminates TLS
  and is reached over a real hostname; the probe measures the routing and the card, not
  the certificate.
- **Crawler rendering is theirs, not ours.** Image cropping, title truncation, and how
  long a card stays cached are decisions made inside Facebook and LINE.
