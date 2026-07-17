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
A Property complete enough for its public page to be worth rendering: at least one photo and at least
one Unit priced above zero. A zero-priced Unit is a placeholder, not sellable inventory.
_Avoid_: complete, live, published

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
