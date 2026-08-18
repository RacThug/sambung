# Research - How fast is iCal, really? (and what staleness threshold follows)

**Asked:** 2026-08-18 · **For:** [`../spec/honesty-sync-ux.md`](../spec/honesty-sync-ux.md) (PRD-product
P0-3, REQ-AV-04) · **Question:** is a 90-minute staleness threshold right for a Bali property, and what
should the product actually *tell* an owner about the sync window?

> **How to read this.** Third-party cadences change without notice, and only one of them is documented
> by the platform itself. Every row below is labelled **primary** (the platform's own docs) or
> **secondary** (an operator or vendor reporting it). Treat secondary numbers as an order of magnitude,
> not a contract - and re-measure them in the P0-3 live pilot, which is the only source that can be
> authoritative for our feeds.

## 1. What the OTAs do

| Leg | Cadence | Confidence | Source |
|---|---|---|---|
| Airbnb re-reads a calendar you gave it | **every 3 hours**, with a manual *Refresh* and an explicit rate limit ("we're only able to request updates from the other website so many times") | **primary** | [Airbnb Help 99](https://www.airbnb.com/help/article/99) |
| Booking.com re-reads an imported iCal | ~1-2 hours | secondary | [EazyAL](https://www.eazyal.com/blog/how-to-sync-airbnb-booking-com-calendars-ical-guide), [AirROI](https://www.airroi.com/glossary/ical-sync) |
| Vrbo re-reads an imported iCal | ~1 hour | secondary | [Lodgify](https://www.lodgify.com/blog/import-availability-calendar-homeaway-vrbo-ical/) |
| Any platform, general | 30 minutes to 6 hours, "typically 1 to 4" | secondary | [AirROI](https://www.airroi.com/glossary/ical-sync), [ICS Viewer](https://icsviewer.com/blog/sync-airbnb-booking-vrbo-ical) |
| Export URLs get regenerated for security | occasionally, silently - every import must then be re-pasted | secondary | [ICS Viewer](https://icsviewer.com/blog/sync-airbnb-booking-vrbo-ical) |

## 2. What comparable software does

| Product | Import polling | Source |
|---|---|---|
| Hostfully (PMS) | **every 20-30 minutes** | [Hostfully docs](https://help.hostfully.com/en/articles/3032151-synchronize-using-icals) |
| Lodgify | auto-refresh **every 2 hours** | [Lodgify](https://www.lodgify.com/blog/import-availability-calendar-homeaway-vrbo-ical/) |
| Smoobu | declines to promise one - "does not depend on Smoobu" | [Smoobu support](https://support.smoobu.com/hc/en-us/articles/360014013580-iCal-troubleshooting-Smoobu-s-iCal-calendar-is-not-being-updated-on-your-portal) |

**Sambung's 30-minute sweep sits at the fast end of the whole category** - level with the fastest PMS
found, four times faster than Lodgify, six times faster than Airbnb's own cadence. Nothing in this
research argues for shortening it; Airbnb's documented rate limit argues against.

## 3. Why the market makes the window expensive here

| Metric | Indonesia | Global | Source |
|---|---|---|---|
| Hotel booking lead time (2025) | **19 days** | 32 days | SiteMinder *Hotel Booking Trends* (130M bookings), reported by [Tempo](https://en.tempo.co/read/2086132/how-indonesian-tourist-hotel-stay-patterns-are-changing) and [SiteMinder](https://www.siteminder.com/news/siteminder-hotel-booking-trends-2026/) |
| Cancellation rate | ~11.4%, reported as the world's lowest | - | same *(reported ambiguously as "decreased by 11.38%" in one retelling - treat the direction, not the decimal)* |

Not fetchable directly: siteminder.com and tempo.co both answered **403** to an automated fetch, so the
19-day figure rests on two independent retellings of one primary report, not on the report itself.
**Confidence: medium.** The direction is what matters and it is unambiguous - Indonesia books later than
almost anywhere, so a larger share of bookings lands inside any sync window, and a night blocked late is
a night that was likely about to be sold.

## 4. The finding that actually matters: the legs are asymmetric

The dangerous lag is **not ours**.

```
OTA books a night   --> Sambung learns of it     : our pull, <= 30 min      (we control this)
Guest books direct  --> Airbnb learns of it      : Airbnb's pull, ~3 hours  (we control nothing)
```

Inbound is a solved problem at 30 minutes. **Outbound is up to three hours and is not ours to fix** -
Airbnb decides when it reads the file, rate-limits how often it can be asked, and offers the owner only
a manual *Refresh* button on its own site. So the real double-booking exposure for a Sambung direct
booking is roughly **1-3 hours on the OTA side**, dominated entirely by the leg we cannot influence.

Two consequences:

1. **The honesty copy was aimed at the wrong leg.** "We check your OTA calendars every 30 minutes" is
   true, reassuring, and describes the *safe* half. The sentence an owner needs is the other one: *a
   direct booking on Sambung can take up to about three hours to close on Airbnb, because Airbnb decides
   when it reads your calendar - and the manual Refresh on Airbnb's own page is the way to hurry it.*
   That single sentence is worth more than the entire freshness indicator, and it comes with a primary
   citation.
2. **Tuning the staleness alarm between 60 and 90 minutes is second-order.** It is a rounding error
   against a three-hour structural window. The threshold should therefore be chosen for what it actually
   is - a liveness alarm on our own sweeper - not as an availability-risk knob.

## 5. So: is 90 minutes right?

**Yes, for the owner-facing warning.** Reasoning, not vibes:

- **What staleness detects.** A feed that cannot be fetched already goes `error` with a reason. So an
  `ok` feed whose age keeps growing means one thing: **our sweeper stopped running**. That is a liveness
  signal, and every feed crosses the line together.
- **Missed-heartbeat convention.** 90 minutes = three missed sweeps. One skipped tick is *designed*
  behaviour (the re-entrancy guard skips a tick while the previous sweep is still in flight), two is
  noise, three is a fault. Alarming at one missed sweep would fire on the system working as intended.
- **False alarms cost trust, and trust is the feature.** An owner who is warned about a fine calendar
  twice stops reading the warning - at which point the honest UX has made things worse than silence.
- **The cost of the delay is bounded by a bigger number anyway.** In the worst 90 minutes of undetected
  staleness, the owner is exposed to less risk than they carry all day from Airbnb's own 3-hour pull.

**But 90 minutes is the wrong number for the operator.** RacThug should know a dead sweeper in ~35
minutes (one missed tick, fleet-wide), because he is the one who can restart it; the owner should hear
about it at 90 minutes, because until then there is nothing for them to do. **Two audiences, two
thresholds** - and the tight one belongs to P0-4 (monitoring + alerting), not to this slice.

## 6. What would change this answer

- The live-OTA pilot (P0-3) measuring **real** timestamps: if Airbnb's export feed turns out to be CDN
  cached by tens of minutes, the inbound leg is slower than assumed and the copy needs a second number.
- Feed count growing enough that one sequential sweep approaches 60 minutes - at that point 3 sweeps is
  no longer a safe tolerance and the sweep needs concurrency before the threshold needs changing.
- Any OTA publishing a real cadence commitment, which would upgrade rows in §1 from secondary to primary.
