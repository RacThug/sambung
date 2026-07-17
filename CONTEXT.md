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

### Bookings

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
