# Sambung

A multi-tenant direct-booking engine and lightweight channel manager for Bali accommodation owners.
This file is the glossary: what the words mean, and which words not to use. It is not a spec - the
product/schema/architecture docs live in [`docs/`](docs/README.md).

## Language

### Ownership

**Tenant**:
One accommodation business on Sambung. Every piece of inventory and every booking belongs to exactly one.
_Avoid_: account, organization, workspace, client

**Owner**:
The person who runs a Tenant and its inventory.
_Avoid_: host, landlord, admin

**Visitor**:
Someone reading a public page. They have booked nothing and belong to no Tenant - but they are
always looking at exactly one Tenant's Property, so a Visitor is never tenant-less.
_Avoid_: anonymous, public user, lead

**Guest**:
Someone a booking is for. A Visitor becomes a Guest by booking; that conversion is what the funnel
exists to cause, so the two are not the same word.
_Avoid_: customer, visitor, user

### Inventory

**Property**:
A place guests stay at - a villa, homestay, or guesthouse. Belongs to exactly one Tenant.
_Avoid_: listing, hotel, place

**Unit**:
Exactly one sellable thing: a single room or villa that can host at most one Stay at a time.
Three identical garden rooms are three Units, not one Unit with a count of three.
_Avoid_: room type, inventory, listing

**Verified**:
A Property whose licence (NIB) is on file. A claim about paperwork, not a quality judgement by Sambung.
_Avoid_: approved, certified, trusted

**Publishable**:
A Property whose public page is complete: at least one photo and at least one Unit priced above zero.
A zero-priced Unit is a placeholder, not sellable inventory.
A readiness checklist shown to the Owner - **not** a gate. The public page renders either way, so
that deleting a photo can never silently kill a link already in the wild. Nothing is "unpublished".
_Avoid_: complete, live, published

**Slug**:
A Property's permanent public address (`/p/seminyak-beach-villa`). Minted once from the name and
never moved by a rename - it is where the Property lives, not what it is called.
_Avoid_: url, permalink, handle

**Archived**:
Inventory the Owner has retired. It keeps its bookings and payments, disappears from the public page
and every new-booking path, and stays visible to the Owner as history. A Unit is Archived on its own
account or by inheriting an Archived Property - the effective state is derived from both, never stored
twice. Distinct from delete, which is only for inventory that was never booked.
_Avoid_: deleted, hidden, disabled, deactivated, unpublished

### Bookings

**Booking**:
The base entity: one claim on a Unit's Stay, held in exactly one status (`pending_payment`,
`confirmed`, `cancelled`, `expired`) and attributed to one source. The umbrella under which Stay,
Hold, Walk-in, Block and Occupying are facets - and the word the code and API use everywhere
(`booking`, never `reservation`).
_Avoid_: reservation (for the entity), order, ticket

**Stay**:
The nights a booking covers, as a half-open range `[check-in, check-out)`. The check-out date is not a
night. Two Stays that merely touch (one ends the day the next begins) do not overlap.
_Avoid_: date range, period, duration

**Occupying**:
Said of a booking that is holding its Unit's calendar against everyone else - awaiting payment, or
confirmed. Cancelled and expired bookings are not Occupying, so their nights are sellable again.
_Avoid_: active, blocking, live

**Hold**:
A booking that has claimed a Stay while its guest pays, and lapses on its own if they don't.
_Avoid_: reservation, lock, pending

**Walk-in**:
A booking the Owner records directly for a real Guest - by phone, in person, over WhatsApp - born
`confirmed` with no online payment. Its source is `direct`: a walk-in is direct business, just not
self-service. "Walk-in vs online" is derived (a confirmed direct booking with no payment), never a
stored source.
_Avoid_: offline booking, manual booking, phone booking

**Block**:
Nights the Owner holds against booking for a non-Guest reason - maintenance, personal use, a deal
done off Sambung. A `manual_block` booking, born `confirmed`, with no Guest and no price. It Occupies
the calendar exactly like a Stay but sells nothing, and is lifted by cancelling it (the same verb as
any booking), which frees the nights instantly.
_Avoid_: manual block, hold, reservation, closure, lock

**Availability**:
Which nights a Unit is free, derived from the absence of an Occupying booking - never stored
(invariant #3). A question you ask the booking rows, not a table you keep. Not "the Calendar":
the Calendar is the Owner's occupancy view, availability is the derived free/busy its gaps imply.
_Avoid_: vacancy, openings

**Calendar**:
The Owner's cross-Unit occupancy view (the dashboard home, `/app/calendar`): every Unit's Occupying
bookings over a window, drawn as bars colored by source (direct / airbnb / booking_com / vrbo /
manual) with Holds hatched. It shows the positive space - who is in, and through which channel - so it
is the opposite of Availability, which is the negative space its gaps imply. One Unit per row; a
Cancelled or expired booking is not Occupying, so it never draws a bar.
_Avoid_: availability, schedule, agenda, timeline

**Reservation**:
The Owner's management *view* of Bookings - the filterable, shareable list at `/app/reservations`.
A lens over the same Booking rows the Calendar draws (one read path, ADR-0010), not a separate thing:
there is no Reservation entity or table. Where the Calendar shows only Occupying bookings as bars, the
Reservation list shows *every* status as rows - an owner searches for cancelled and expired ones too.
_Avoid_: booking (as the name for the list), order, itinerary

**Quote**:
The answer to "can this Unit host this Stay, and at what price": whether the nights are free, the
total (base price x nights), and machine-readable reasons if not (`overlap`, `min_stay`). Advisory -
recomputed at checkout, and it holds nothing.
_Avoid_: estimate, price check

**Changeover**:
The day a departing Guest's check-out is the next Guest's check-in. Because a Stay is half-open the
two do not overlap, so the day is immediately bookable - the calendar bug this whole model exists to
kill.
_Avoid_: turnover, gap day

### Payments

**Deposit**:
The share of a booking's total the Guest pays online at checkout, set per Property as a percentage
(1-100, default 100). 100% is pay-in-full; anything less is a partial deposit, the balance settled at
the Property. It scales the amount charged, never the Stay's total - a booking always records its full
price.
_Avoid_: down payment, prepayment, part-payment

**Payment**:
The record of one attempt to collect a booking's Deposit through the Provider - the amount charged and
the Provider's session, not the money itself. A booking has at most one open (unpaid) Payment at a
time: retrying checkout reuses that row and its session rather than minting a second, so "pay again"
never means "charge twice". A Payment is settled by the Provider's webhook, never by the Guest's return.
_Avoid_: charge, transaction, invoice, order

**Provider**:
The external gateway that hosts the Guest's card entry and later reports the outcome - Midtrans in the
sandbox for v1. The Guest is redirected out to it and back; Sambung stores only the session it hands us
and, later, the event it sends. Nothing in the domain knows a Provider's shape beyond that boundary.
_Avoid_: gateway, processor, PSP, Midtrans (as the general term)

**Settlement**:
The Provider's report that a Payment's money has arrived - delivered as an at-least-once webhook, and the
only thing that turns a Hold into a confirmed booking. The Guest returning from the Provider's page is not
a settlement; only the webhook is. A settlement that arrives after the Hold has lapsed records the money
but never resurrects the booking - it is a refund to sort out, not a confirmation.
_Avoid_: capture, callback, payment confirmation, notification
