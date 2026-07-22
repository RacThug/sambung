# The five-minute demo

The scripted walkthrough behind [PRD §8](prd.md#8-success-criteria-portfolio-lens) and goal **G5**:

> owner adds a property → guest books and pays (sandbox) → the dates block on an external calendar, live, in under 5 minutes.

Read it aloud while you drive. Every URL, button label and screen state below was checked
against the running app, and the seed is built to open in exactly the state the script
describes. Where a step cannot be exercised on a laptop (a real OTA subscribing to the feed,
a live link-preview crawler), the script says so instead of pretending.

---

## Before you start

**Once per machine**

```bash
pnpm install
docker compose up -d                          # Postgres + Garage (photo storage)
cp packages/db/.env.example packages/db/.env  # dev fixture credentials, committed on purpose
cp apps/api/.env.example apps/api/.env
pnpm --filter @sambung/db db:migrate
pnpm --filter @sambung/db db:setup-role
```

Do not skip the two `cp` lines. `scripts/load-env.ts` reads the `.env` with a silent catch and
no fallback, so without them `db:migrate` has no `DATABASE_URL` and fails on a fresh clone.

**Immediately before you present** (this is the "fresh `db:reset`" the acceptance criterion means)

```bash
pnpm --filter @sambung/db db:reset       # drop, replay every migration, seed   (~3s)
pnpm dev                                 # web on :5173, api on :3000           (~10s to boot)
```

`db:reset` prints the demo calendar it just built. Glance at it before you start talking:

```
Demo logins: owner@balibreeze.test / owner@ubudretreats.test / staff@balibreeze.test (Seminyak only) - password "sambung123"
Demo window (all future, half-open, all within a week):
  Wayan D., paid direct  2026-07-22 -> 2026-07-25  (Whole Villa)
  refused Airbnb import  2026-07-23 -> 2026-07-26  (the inbox conflict)
  Komang S., live hold   2026-07-23 -> 2026-07-25  (Garden Room, 15 min)
  maintenance block      2026-07-24 -> 2026-07-27  (Surf Loft)
  imported from Airbnb   2026-07-27 -> 2026-07-29  (Whole Villa)
  bookable gap           2026-07-25 -> 2026-07-27  (Whole Villa, 2 nights = its min stay; picker demo only)
```

Those dates move with the calendar: they are anchored to *today*, never to fixed dates, so the
funnel (which hides the past) and the export feed (which serves current and future stays) always
have something to show. The script never names an absolute date for that reason.

Everything also starts within six days, so the dashboard's opening screen (which shows the
current calendar month) has every bar on it. The one case that cannot work is the last few days
of a month, when the month has no future days left to put them in: `db:reset` prints a NOTE
telling you to click the next-month arrow, and there is nothing else to be done about it.

**Two things to have ready**

| | Why |
|---|---|
| `MIDTRANS_SERVER_KEY` in `apps/api/.env` | Sandbox key from [dashboard.sandbox.midtrans.com](https://dashboard.sandbox.midtrans.com) → Settings → Access Keys. Without it, Act 2's payment step leaves the guest on **"Your dates are held"** with **"Payment couldn't start. Please try again."** and a **Retry payment** button. (The server-side cause, in the API log, is *"Payments are not configured (MIDTRANS_SERVER_KEY is unset)"*.) See the fallback at the end of Act 2. |
| Two browser windows | One signed in as the owner, one for the guest. Use a private window for the guest so the two sessions do not share a token. |

**The 15-minute hold is real.** The seeded hold on the Garden Room expires 15 minutes after
you seed, and the sweeper reaps it. Seed right before you present. If it lapses mid-demo,
that is a talking point, not a failure (see the encores).

---

## The clock

`db:reset` takes about 3 seconds and the whole server-side path of this script (log in, create
a property, create a unit, quote dates, place a hold, read the confirmation, fetch the `.ics`,
list the inbox) completes in about **1 second** end to end. The five minutes is entirely
talking and clicking: the machine is never the thing you are waiting for. Budget per act:

| Act | What | Budget |
|---|---|---|
| 1 | The owner adds a property | 60s |
| 2 | The guest books and pays | 2m |
| 3 | The dates block on an external calendar | 45s |
| 4 | The double-sell that never happened | 60s |

---

## Act 1 - the owner adds a property (60s)

1. Open **http://localhost:5173/login**. Sign in as **`owner@balibreeze.test`** /
   **`sambung123`**.

2. You land on **`/app/calendar`**, the unified calendar. One row per *unit* across every
   property. On the four seeded stays you should see all three bar colours - a direct booking,
   an Airbnb-imported one, a maintenance block - plus the unpaid hold, hatched.

   > "This is the owner's whole business on one screen. Every bar is a `booking` row. There is
   > no availability table anywhere in this system: free means no row overlaps you."

   The view opens on the current calendar month, and the seeded stays start within six days, so
   they are on it - unless you seeded in the last few days of a month, in which case `db:reset`
   printed a NOTE and you click **›** once.

3. **Properties** in the top nav → **New property** → name it **`Uluwatu Cliff House`** →
   **Create**.

4. You land on the property's edit page. Point at the line under the title:

   > "Its public URL was minted the moment it was created, and it never moves again, even if
   > the name changes. This link is going into an Airbnb profile and a WhatsApp thread."

   Note the banner: *"The public page is live, but incomplete - it needs at least one photo
   and one unit with a price before it's worth sharing."* That is a checklist, not a gate.
   The page is already live. (Optional, 15s: drag a photo into **Photos** → **Add photos**. The
   browser uploads it straight to object storage with a presigned URL; the API never touches
   the bytes.)

5. Scroll to **Units**. In the bottom row of the table type **`Cliff Suite`**, price
   **`2000000`**, guests **`2`**, min stay **`1`** → **Add unit**.

   > "One row is one sellable thing. Three identical rooms are three rows, because a room type
   > with a quantity cannot be guarded by a database constraint."

6. Click **Copy link** next to the public URL.

---

## Act 2 - the guest books and pays (2m)

7. In the **guest window**, paste **the link you just copied**. On a fresh seed it is
   `http://localhost:5173/p/uluwatu-cliff-house`, but do not type that from memory: slugs are
   minted once and never reused, so rehearsing twice without re-seeding gives the second
   property a random suffix (ADR-0004) and the remembered URL 404s.

   Optional (10s, the i18n beat): switch the **Language** selector top-right to
   **Bahasa Indonesia**, then back. Dates, nights and copy follow the language; prices stay in
   rupiah and the wire format never changes.

8. Under **Cliff Suite**, click **Check availability**. Pick a check-in a couple of days out
   and a check-out two nights later. The card reads **Available**, *"2 nights · Rp 4.000.000"*.

   > "Past dates are the only thing this calendar refuses on its own. Booked nights are greyed
   > but still selectable, because the server is the only authority on what is taken. A client
   > that decided for itself would be a second definition of 'booked' waiting to drift."

   The selection lives in the URL, so this exact quote is a shareable link.

9. **Book these dates** → the checkout at **`/p/uluwatu-cliff-house/book`**. Fill in
   **Full name**, a **WhatsApp number** (leave the country on Indonesia), optionally an email.
   Click **Continue to payment**.

   > "That click did not just take their details. It opened one transaction, swept any lapsed
   > holds, re-checked availability, inserted the booking, and let a Postgres exclusion
   > constraint arbitrate. Two guests clicking the same nights at the same millisecond: one
   > gets a booking, the other gets a 409. Not because the code is careful, because the
   > database makes the overlap unrepresentable."

10. You are redirected to **Midtrans Snap (sandbox)**. Pay with one of Midtrans's published
    sandbox test cards (`4811 1111 1111 1114`, any future expiry, CVV `123`, OTP `112233`).
    Have their [sandbox testing page](https://docs.midtrans.com/docs/testing-payment-on-sandbox)
    open in case they have rotated the numbers.

11. Snap returns you to **`/booking/<id>`**. It shows **"Confirming your payment…"** and then
    **"You're all set"** with the stay, the amount paid, and a
    **Send WhatsApp confirmation** button.

    > "That page did not just poll. It pulled the payment status from the provider and ran it
    > through the exact same idempotent transition the webhook uses, so a webhook that never
    > arrives still confirms the booking, and a webhook that arrives twice does nothing the
    > second time. The confirmation email fires exactly once either way."

**No sandbox key?** Stop after step 9: the hold is real and the dates are already held. Say so,
then record the same stay from the owner side instead: on `/app/calendar`, find the **Cliff
Suite** row, click an empty day on it, choose **Walk-in**, and **Add walk-in**. That booking is
born `confirmed` and Act 3 works unchanged.

**Book on the Cliff Suite, not the Whole Villa.** If you improvise an extra booking, keep it on
the property you just created. The seed leaves a bookable two-night gap on the Whole Villa, and
taking it puts a second booking under the conflict Act 4 is about - so *"here is the booking in
the way"* becomes a list of two, and the beat needs explaining instead of landing. The gap is
there for the picker (it greys nights on both sides of your selection), not for a booking you
are about to talk over.

---

## Act 3 - the dates block on an external calendar (45s)

12. Back in the **owner window**, open **`/app/calendar`**. The new booking is on the Cliff
    Suite row. Click the bar to open **`/app/bookings/<id>`**: guest, phone, email, total.

13. Open the property's edit page → **Channels** → the **Cliff Suite** panel. Under *"Export
    calendar (paste into the OTA's "import calendar" setting)"* click **Copy**.

14. Paste that URL into a browser tab. You get raw iCalendar, with one `VEVENT` for the nights
    the guest just booked:

    ```
    BEGIN:VEVENT
    UID:<the booking id>
    DTSTAMP:20260721T075658Z
    DTSTART;VALUE=DATE:<check-in>
    DTEND;VALUE=DATE:<check-out>
    SUMMARY:Unavailable (Sambung)
    TRANSP:OPAQUE
    END:VEVENT
    ```

    > "This is the URL an owner pastes into Airbnb, Booking.com and Vrbo. It is unauthenticated,
    > because an OTA's crawler has no login: the unguessable unit UUID is both the address and
    > the key, and it resolves the tenant and then reads under row-level security, so it is
    > structurally incapable of becoming a cross-tenant read. And look at what is in it: dates
    > and the word Unavailable. No name, no email, no price. Not filtered out. There is no
    > field for them."

    **Not in this script:** actually subscribing an OTA to the feed. That needs a public https
    origin and the OTA's own poll cycle (hours). The feed itself is what you show.

15. Connect the other direction while you are here: in the same panel pick a **Channel**, paste
    a public https `.ics` URL (a Google Calendar "secret address in iCal format" works as an
    OTA stand-in), and **Connect**.

    Three different refusals live here, and it is worth being precise about which is which:

    | What you paste | What happens |
    |---|---|
    | `http://…` (not https) | Refused at the boundary by zod: **400**, *"must be an https URL"*. It never reaches the network. |
    | `https://…` that is down or does not resolve | **Connects**, badge **Sync error**, `lastError` *"Feed is unreachable"*. |
    | `https://127.0.0.1/…` or `https://192.168.0.9/…` | **Connects**, badge **Sync error**, `lastError` *"Feed host is not allowed"*. |

    Only the first is the endpoint refusing to *save*. The other two saved fine: the smoke fetch
    reports back and the badge carries the news, and in the third case what refused was the SSRF
    guard declining to *fetch* a private address. So a `localhost` feed can be connected here.
    It simply never syncs.

    > "The import runs every 30 minutes, or on demand. Each event gets its own savepoint, so
    > one bad event skips instead of killing the cycle, and a truncated feed is detected and
    > changes nothing rather than mass-cancelling real stays."

---

## Act 4 - the double-sell that never happened (60s)

16. Open **Inbox** in the top nav (**`/app/inbox`**). Under **Calendar conflicts**:

    *"Airbnb booking couldn't be imported"* · Seminyak Beach Villa - Whole Villa · the stay
    dates · **First seen** with a date two days back, and under **Already booked here**,
    Wayan D.'s confirmed direct booking on overlapping nights.

    > "Airbnb sold nights this owner had already sold direct, and been paid for. The import
    > tried to write it and the exclusion constraint refused, so the system did the one safe
    > thing: it kept both bookings intact, wrote down what it could not do, and asked a human.
    > It never auto-cancels a confirmed booking, because that is somebody's holiday.
    >
    > The 'already booked here' list is not stored. It is derived at read time with the same
    > date-overlap operator the constraint itself used, so it is exactly the set that caused
    > the refusal.
    >
    > And there is no 'resolve' button, only **Dismiss**. Resolving would let the UI claim
    > something the database still refuses. Cancel the losing booking and the next sync clears
    > this by itself. Dismiss is a judgement, so it stays dismissed. Anything the system
    > measures again can come back."

17. Click **Dismiss** on the conflict. It leaves the inbox.

    Then, if you want the last beat: **View booking ›** under *Already booked here* opens the
    blocking reservation at `/app/bookings/<id>` - the stay that won, guest and all. That link
    navigates away from the inbox, so take it last, or use the browser back button to return.

Below it sits the inbox's other half, **Payments needing attention**. The seed leaves it on
**All clear**, deliberately: it fills when a guest pays *after* their hold lapsed, so the money is
captured but the nights are no longer held. Marking one handled writes a single marker column and
never touches the ledger, because "an operator dealt with this" is a different fact from what the
money did.

**That is the demo.** Owner added a property, guest booked and paid, the nights left the
building as an OTA-consumable feed, and a real double-sell was caught by the database rather
than discovered by a guest at the door.

---

## Encores, if they ask

| They ask | Show them |
|---|---|
| "Is the multi-tenancy real?" | Sign in as `owner@ubudretreats.test` (same password). Different properties, different calendar, and the first tenant's booking IDs 404 rather than 403. Row-level security in Postgres, not a `WHERE` clause someone can forget. |
| "What if two people book at once?" | `apps/api/src/bookings/bookings.spec.ts` fires two bookings at the same nights concurrently, against a real Postgres. One gets a booking, one gets a 409, every time. |
| "Can they get their data out?" | **Reservations** → filter → **Export CSV**. Exact integer rupiah, no float, formula injection neutralised. |
| "What happens to an unpaid hold?" | The seeded Garden Room hold expires 15 minutes after `db:reset`. Reload the calendar afterwards: the hatched bar is gone and the nights are bookable again. Cleared at two scopes, one inside the booking transaction and one on a cron. |
| "Can I give my manager access to one villa?" | Sign in (private window) as `staff@balibreeze.test`, same password. They are assigned **Seminyak only**, so the calendar, the reservations list and **Properties** show Seminyak and not Canggu - and pasting Canggu's URL gives a 404, not a 403: within a tenant, an unassigned property simply does not exist for them. **Settings** shows the gallery cap read-only and no Team form. Same mechanism as the multi-tenancy answer above - a second axis in the same row-level security policies, so no endpoint had to be taught about it. |
| "How much does this cost to run?" | One ~$5/month VPS. No paid third-party service anywhere in the stack. |

## Deliberately not in this script

- **A real OTA subscribing to the export feed.** Needs a public https origin and their poll
  cycle. Step 14 shows the feed an OTA would read.
- **Link-preview verification** (Facebook Sharing Debugger, a real WhatsApp or LINE share).
  Needs the deployed public URL, and those crawlers cache hard. It is a demo-day checklist item,
  tracked on [#60](https://github.com/RacThug/sambung/issues/60).
- **Live email delivery.** Unconfigured, the mailer renders the confirmation email to the log
  rather than sending it. Set `RESEND_API_KEY` and `MAIL_FROM` to send for real.

## If something goes wrong

| Symptom | Fix |
|---|---|
| `db:migrate` cannot find `DATABASE_URL` | The `cp .env.example .env` steps were skipped. `load-env.ts` swallows the missing file. |
| Login fails | The seed ran against a different database than the API. Check `DATABASE_URL` in `apps/api/.env` and `packages/db/.env` match. |
| The calendar looks empty | You seeded in the last few days of a month, so the stays are in the next one. Click **›**. `db:reset` warns when this applies. |
| **"Payment couldn't start. Please try again."** on a "Your dates are held" panel | `MIDTRANS_SERVER_KEY` is unset (the API log says so plainly). Use the Act 2 fallback. |
| The public page 404s | The property is archived, or the slug is wrong. An archived property's URL stays reserved and returns 404 on purpose. |
| Photos do not load | Garage is down (`docker compose up -d`). The rest of the demo is unaffected. |
| The hold has already lapsed | Re-run `db:reset` (about 3 seconds). |
