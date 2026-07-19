# ADR-0013: Rate limits are tiered, and a 429 follows the envelope

- **Date**: 2026-07-19
- **Status**: Accepted
- **Issue**: #59
- **Builds on**: #48 (the env-driven global throttler + `TRUST_PROXY`), api-spec §8.3 (public endpoints are rate-limit candidates), ADR-0012 (one error envelope; the conflict `code` set is closed)

## Context

#48 shipped ONE global throttler: a generous `default` (60 req / 60s, env-driven, protective) on every route, in-memory (single VPS, no Redis), keyed on the client IP once `TRUST_PROXY` lets the app see it behind Caddy. api-spec §8.3 named the routes that need MORE than the generous default - auth `login`/`register` (credential guessing, signup flooding) and the no-auth `POST /public/bookings` (calendar griefing) - and deferred the tightening to M5.

Two forces shape the how:

- **The tight limit can't be global.** A legit owner loading the calendar fires three reads, then navigates - a 10/min ceiling on *every* route breaks normal use. The tight limit must apply to a named few and nowhere else.
- **The test suite must stay fast and green.** The other specs log in and book *repeatedly* (the boss-fight concurrency test fires 10 bookings at once). A hard-wired tight limit would 429 them. So the tight limit must be env-tunable (off in test) exactly like the default tier, which rules out baking the numbers into a decorator - a decorator's value is captured at class-load, before `ConfigService` exists, so it can't be env-driven the way the module factory is.

And the refusal itself: `@nestjs/throttler`'s `ThrottlerException` renders `{ statusCode, message }` from a bare string - it drops the `error` field every other refusal in this app carries. The web's `ApiError` reads `{ statusCode, error, message }`.

## Decision

**Two named throttlers, the tight one gated by a route marker; the 429 rendered in the app's error envelope.**

- **`default`** (unchanged): generous, env-driven, on every route.
- **`sensitive`**: a second named throttler, env-driven (`THROTTLE_SENSITIVE_LIMIT`/`_TTL_MS`, protective default 10 / 60s), configured in the SAME `ThrottlerModule.forRootAsync` factory so it reads `ConfigService` at module init - the one place that can. It applies ONLY where opted in: a `@ThrottleSensitive()` metadata marker on `login`, `register`, and the public booking write, and a `skipIf` on the throttler that skips it everywhere the marker is absent. Each throttler keeps its own per-handler bucket (the key hashes class + handler + throttler name + IP), so a login burst can't exhaust a guest's booking allowance.
- **`EnvelopeThrottlerGuard`** replaces the stock `ThrottlerGuard` as the global `APP_GUARD`. It overrides only `throwThrottlingException`: rethrow an `HttpException` with `{ statusCode: 429, error: 'Too Many Requests', message }`, and set the standard `Retry-After` header (the base guard, with named throttlers, only emits a suffixed `Retry-After-sensitive` a generic client won't read).

**The 429 is NOT a conflict `code` slug.** ADR-0012's `conflictCodeSchema` is a *closed* set for domain 409s - facts about the world the client can resolve by changing the request ("these dates are taken"). A 429 is infrastructure back-pressure: the request was fine, the client is simply too fast. It carries the generic envelope + `Retry-After`, not a domain slug.

## Why

**A marker + `skipIf` beats a hard-wired route list.** The decision to tighten a route lives *next to the route* (`@ThrottleSensitive()`), greppable, and adding a route is one decorator - no central list to keep in sync with the controllers. `skipIf` runs per request against handler metadata, so the tight throttler is a genuine no-op on the other 40 routes rather than a limit someone has to remember to raise.

**Env-driven, in the factory, because the test suite is a first-class caller.** The default tier is env-off in test for a reason (#48); the tight tier inherits the exact discipline. Keeping BOTH limits in the `ConfigService` factory means the throttle test lowers one env var before it compiles its own app and fires `limit + 1` requests - proving the ceiling instantly, with no `sleep` and no window to wait out - while every other spec sees the high value from `.env`. A decorator-captured constant could not be lowered per-app that way, and a hard-coded tight limit would 429 the concurrency test.

**One envelope, or the web special-cases a shape.** Every refusal this app emits is `{ statusCode, error, message, ...detail }`; a 429 that omits `error` is a second shape the client must branch on. Rendering it through the guard makes a rate-limit refusal indistinguishable *in shape* from a 404 or a 409 - the client reads `statusCode` to know it's throttled and `Retry-After` to know when to retry, the same machine-readable discipline ADR-0012 gave the 409.

## Consequences

- **`app.module` gains a second throttler + swaps the guard class.** The factory now injects `Reflector` (for the `skipIf` metadata read) alongside `ConfigService`.
- **Three routes carry `@ThrottleSensitive()`:** `auth.login`, `auth.register`, `public-bookings.create`. `refresh`/`logout` stay on the default tier - they carry a cookie, not a guessable secret, and throttling `refresh` would log a user out.
- **Two env vars are added** (`THROTTLE_SENSITIVE_TTL_MS`, `THROTTLE_SENSITIVE_LIMIT`), documented in `.env.example` with the same "off in dev/test, protective default in prod, per-client only with `TRUST_PROXY`" guidance as the default tier.
- **The 429 body is tested against the envelope** and the standard `Retry-After` header, driven by a per-app env override rather than real time - so the suite gains four throttle assertions without slowing.
- **No CAPTCHA, no distributed store** (api-spec §8.3, invariant #8): in-memory on one VPS is the whole design; a horizontal scale-out is the trigger to revisit (a shared `ThrottlerStorage`), recorded here so it isn't a surprise.
