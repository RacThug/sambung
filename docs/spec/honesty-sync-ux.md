# EARS spec - Honesty sync UX (PRD-product P0-3, REQ-AV-04)

**Status:** proposed (awaiting owner sign-off, 2026-08-18) · **Traces to:**
[`../prd-product.md`](../prd-product.md) P0-3, ADR-0040 (proposed - *a fleet's freshness is its stalest
feed*), api-spec §7.7 (new read) + §7.2 amendment, page specs
[`../pages/app-calendar.md`](../pages/app-calendar.md) /
[`../pages/app-properties-propertyId.md`](../pages/app-properties-propertyId.md) (REQ-AV-04
amendments), shared contract `packages/shared/src/channel.ts`. **No migration** - every fact here is
derived from columns `channel_connection` already has.

> **Format** as [`date-based-pricing.md`](./date-based-pricing.md): one testable sentence per row; the
> **Verified by** test is what makes it falsifiable - a row whose named test does not prove it is a
> claim, not a requirement.

**The gap this closes.** The sync data already exists on the wire (`lastSyncedAt`, `lastStatus`,
`lastError`) and the page spec records that `lastSyncedAt` is *not rendered*. So the owner is told
**that** a feed synced, never **when** - and a sweeper that silently stops leaves a green "Synced" pill
up forever. The calendar, where availability is actually read, says nothing about OTA freshness at all
until someone clicks *Sync now*. iCal is a pull with a lag; a product that hides the lag is selling a
promise it cannot keep, and overbooking anxiety is this market's #1 emotional issue.

## 1. Staleness is a derived judgement (FR)

The threshold is a **server** policy, and it is judged on the **server's** clock - the same clock that
stamped `last_synced_at`. A browser comparing two timestamps would be judging one clock against
another; on a laptop whose time is 20 minutes out, that produces a "stale" warning about a healthy feed,
or silence about a dead one.

| ID | Requirement | Verified by |
|---|---|---|
| FR-01 | The system shall mark a connection `stale` WHEN its last successful pull is older than the staleness threshold, judged on the server clock at read time. | api `channel-sync/sync-health.spec.ts` (a connection stamped just either side of the threshold) |
| FR-02 | The system shall DERIVE `stale` and never store it - no column, no migration - exactly as effective-archived is derived (api-spec §4.6, ADR-0005 amendment). | `pnpm --filter @sambung/db db:generate` reports no changes on this branch |
| FR-03 | The system shall express the sweep interval as ONE number from which both the cron expression and the staleness threshold are computed (threshold = 3 sweeps), so the schedule and the promise about it cannot drift apart. | api `channel-sync.spec.ts` (pins `IMPORT_SWEEP_CRON === '*/30 * * * *'` and `STALE_AFTER_MINUTES === 3 × IMPORT_SWEEP_INTERVAL_MINUTES`) |
| FR-04 | IF a connection has never synced (`lastSyncedAt` null), THEN it shall report `stale: false` - "never checked" and "checked, long ago" are different facts with different next actions (wait, vs. re-check the URL). | api `sync-health.spec.ts` (a fresh connection is `never`, not stale) |
| FR-05 | The system shall judge staleness independently of `lastStatus`: a feed that has been erroring since its last good pull three days ago is BOTH erroring and stale, and shall report both. A red pill that hides the age understates the damage. | api `sync-health.spec.ts` (status `error` + old timestamp → `stale: true`) |
| FR-06 | `GET /units/:unitId/channels` shall carry `stale` on every connection (§7.2 amendment); adding a response field is lenient by ADR-0031 and breaks no existing consumer. | api `channel-sync.spec.ts` (shape) + `sync-health.spec.ts` |

## 2. The fleet read (FL)

| ID | Requirement | Verified by |
|---|---|---|
| FL-01 | The system shall serve `GET /channels/health` → 200 (auth) carrying `feeds`, `erroring`, `stale`, `neverSynced` and `oldestSyncedAt` for the feeds the caller can see. | api `sync-health.spec.ts` (counts across a mixed fleet) |
| FL-02 | `oldestSyncedAt` shall be the OLDEST successful pull among the visible feeds, not the newest (ADR-0040): a calendar is only as current as its stalest feed, and reporting the newest would be a flattering lie. | api `sync-health.spec.ts` (three feeds, distinct timestamps → the oldest is returned) |
| FL-03 | IF any visible feed has never synced, THEN `oldestSyncedAt` shall be null - there is no complete freshness claim to make - and `neverSynced` shall say how many. | api `sync-health.spec.ts` |
| FL-04 | The read shall answer from stored state in ONE aggregate query: no per-feed fan-out, and no outbound fetch. A GET that makes the server call three OTAs is a denial-of-service handle pointed at your own IP. | api `sync-health.spec.ts` (the fetcher is bound as a spy and asserted never called) |
| FL-05 | WHILE the caller is Staff, the read shall count only feeds under assigned properties - enforced by RLS, not route code (ADR-0032), the same scoping `POST /channels/sync` already inherits. | api `sync-health.spec.ts` (staff branch) + existing db `rls.test.ts` (`channel_connection`) |
| FL-06 | WHEN no feed is connected, the read shall answer `feeds: 0` with every count 0 and `oldestSyncedAt` null, so the UI can say "no OTA calendar connected yet" rather than implying a successful sync - the same distinction `POST /channels/sync` already draws with `feeds: 0`. | api `sync-health.spec.ts` + web `calendar-page.test.tsx` |

## 3. What the owner is told (UX)

| ID | Requirement | Verified by |
|---|---|---|
| UX-01 | The calendar shall carry the fleet's freshness AMBIENTLY - visible on load, without clicking *Sync now*. The page where availability is read is the page that must disclose how current it is. | web `calendar-page.test.tsx` |
| UX-02 | The browser shall PHRASE the age ("checked 12 minutes ago") from `oldestSyncedAt`; the server shall JUDGE whether that age is a problem. Phrasing tolerates a skewed clock; a judgement does not. | web `lib/relative-time.test.ts` (a pure `(iso, now)` function - no fake timers) + FR-01 |
| UX-03 | WHILE any visible feed is stale or erroring, the calendar shall say so in a warning tone and point at Channels - a red pill on a settings page the owner never opens is not a warning. | web `calendar-page.test.tsx` (stale fleet, erroring fleet) |
| UX-04 | Each connection row shall show the age of its own last good sync beside the status pill, and shall mark a stale one - this reverses the page-spec line recording `lastSyncedAt` as not rendered. | web `channels-section.test.tsx` |
| UX-05 | Both surfaces shall carry the same plain-language iCal note from ONE component: sync is a pull every 30 minutes, an OTA can therefore sell a night in the window between pulls, and the export link must be pasted back into each OTA to close the loop. Two surfaces telling the same truth in two wordings is how a product starts contradicting itself. | web `channels-section.test.tsx` + `calendar-page.test.tsx` (both assert the shared component's text) |
| UX-06 | The note shall be permanent copy, not a dismissible tooltip or a one-time banner: it is a standing property of iCal, not an onboarding step. | the component renders unconditionally - there is no dismiss state to test |
| UX-07 | The freshness read shall refetch on an interval and on window focus, and shall be invalidated by BOTH sync verbs (`POST /channels/sync`, `POST /channels/:id/sync`). A freshness indicator that is itself stale is the exact bug it exists to prevent. | web `calendar-page.test.tsx` (a sweep re-reads health) + `channels-section.test.tsx` |
| UX-08 | This slice shall add NO i18n keys: the dashboard is English, the funnel speaks three languages (ADR-0024). | existing web `funnel-i18n.test.tsx` unchanged; no `useTranslation` in the touched dashboard files |
| UX-09 | The owner shall see the whole honest picture end to end: connect a feed, read its age, watch a sweep move it. | e2e `dashboard/channel-lifecycle.spec.ts` (extended) |

## 4. Isolation (invariant #2, ADR-0032)

| ID | Requirement | Verified by |
|---|---|---|
| ISO-01 | The health read shall be scoped by `tenant_id` under RLS; another tenant's feeds shall never appear in any count or in `oldestSyncedAt`. | api `sync-health.spec.ts` (two tenants, one holding a deliberately ancient feed; counts do not bleed) |
| ISO-02 | IF no tenant GUC is set (cold or pool-reset connection), THEN the read shall report `feeds: 0` - fail closed, never fail open to a cross-tenant total. | existing db `rls.test.ts` (fail-closed loop, `channel_connection` row) |
| ISO-03 | The slice shall add no table, column or policy: the read rides `channel_connection`'s existing policies, which is why it inherits both isolation axes for free. | the migration folder is untouched (FR-02) |

## 5. Out of scope (deferred by name)

Guest-facing sync disclosure on `/p/:slug` (the funnel's honest states today are availability and
payments-not-configured; adding sync anxiety to a booking page spends trust rather than building it) ·
email or WhatsApp alerting when a feed goes stale or errors (P1 - it needs a notification channel that
does not exist yet, and this slice is what makes such an alert *derivable*) · auto-retry or backoff for
an erroring feed · a per-pull history or audit log · a per-tenant configurable sweep interval ·
shortening the 30-minute interval itself · Channex / real-time ARI (P2) · localising dashboard copy.
