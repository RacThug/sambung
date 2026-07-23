/**
 * English copy for the public funnel - the SOURCE OF TRUTH for the catalog shape
 * (ADR-0024). `type Messages = typeof en` derives from this object, and `id` /
 * `zh` are annotated with it, so a key added here without a translation there is a
 * compile error. Values are plain strings with `{token}` placeholders; count-nouns
 * arrive pre-formatted (see `i18n/format.ts`), never inflected in the string.
 *
 * Keep EN strings stable - several are asserted verbatim by page tests.
 */
export const en = {
  // Language switcher (page-spec §2 shell).
  "switcher.label": "Language",

  // Landing page (/) - the portfolio front door (#60 follow-up). Guests never
  // reach it (they open a property link); its audience is a reviewer or a
  // returning owner, so it explains the product and routes owners to auth.
  "landing.navLogin": "Log in",
  "landing.getStarted": "Get started",
  "landing.heroTitle": "Commission-free direct bookings for Bali stays.",
  "landing.heroBody":
    "Take payments directly and keep every OTA calendar in sync over iCal - so a room sold on Airbnb can't be sold again here. Built for the villa owner tired of paying 15% to a channel.",
  "landing.viewDemo": "View a live demo",
  "landing.hardTitle": "The five hard parts",
  "landing.hardBody":
    "Booking software lives or dies on a handful of edge cases. Here is how Sambung handles them.",
  "landing.hard1Title": "No double-booking, ever",
  "landing.hard1Body":
    "A Postgres exclusion constraint - not application code - decides who wins the race for the last night.",
  "landing.hard2Title": "Availability is derived",
  "landing.hard2Body":
    "Free nights are computed from real bookings, so the calendar can never drift out of sync with itself.",
  "landing.hard3Title": "Two-way iCal sync",
  "landing.hard3Body":
    "OTA calendars stay in step, and a broken feed never mass-cancels a real stay.",
  "landing.hard4Title": "Idempotent payments",
  "landing.hard4Body":
    "A replayed payment webhook can never double-confirm or double-charge a booking.",
  "landing.hard5Title": "Multi-tenant isolation",
  "landing.hard5Body":
    "Every owner's data is walled off inside the database with row-level security.",
  "landing.stackTitle": "Built on",
  "landing.forGuests":
    "Looking to book a stay? Open the booking link your host sent you.",
  "landing.footerTagline":
    "Direct-booking engine + lightweight channel manager.",

  // Property page (page-spec §3.1).
  "property.notFoundTitle": "This page doesn’t exist",
  "property.notFoundBody":
    "The link may be mistyped, or the property is no longer listed.",
  "property.errorTitle": "Something went wrong",
  "property.errorBody": "We couldn’t load this property. Please try again.",
  "property.metaNotFound": "Property not found - Sambung",
  "property.rooms": "Rooms",
  "property.noRooms": "No rooms are listed yet. Please check back soon.",
  "property.verified": "Verified",
  "property.photoMain": "{name} - main photo",
  "property.photoN": "{name} - photo {n}",

  // Unit card.
  "unit.capacity": "Up to {guests}",
  "unit.minStayNote": "Minimum {nights}",
  "unit.perNight": "/ night",
  "unit.priceOnRequest": "Price on request",
  "unit.notBookable": "Not bookable yet.",
  "unit.checkAvailability": "Check availability",
  "unit.close": "Close",

  // Availability picker + quote card (page-spec §3.1 States).
  "picker.selectDates":
    "Select your check-in and check-out dates to see availability and price.",
  "picker.checkError": "Couldn’t check those dates. Please try again.",
  "picker.retry": "Retry",
  "picker.checking": "Checking availability…",
  "picker.available": "Available",
  "picker.book": "Book these dates",
  "picker.notAvailable": "Not available for these dates",
  "picker.reasonMinStay": "This room has a {nights} minimum stay.",
  "picker.reasonOverlap": "Some of those nights are already booked.",
  "picker.bookedLabel": "Booked:",

  // Checkout (page-spec §3.2).
  "checkout.title": "Request to book",
  "checkout.back": "← Back to the property",
  "checkout.chooseDates": "Choose your dates on the property page to start a booking.",
  "checkout.yourStay": "Your stay",
  "checkout.depositDueNow": "Deposit due now: {amount}",
  "checkout.balanceAtProperty": "Balance {amount} due at the property",
  "checkout.pickOtherDates": "Pick other dates",
  "checkout.holdLapsedTitle": "Your hold has lapsed",
  "checkout.holdLapsedBody":
    "We only hold dates for a few minutes. Please pick your dates again to start over.",
  "checkout.pickDatesAgain": "Pick dates again",
  "checkout.yourDetails": "Your details",
  "checkout.fullName": "Full name",
  "checkout.whatsapp": "WhatsApp number",
  "checkout.country": "Country",
  "checkout.loading": "Loading…",
  "checkout.unavailable": "Unavailable",
  "checkout.countryLoadFailed": "We couldn't load the country list.",
  "checkout.emailOptional": "Email (optional)",
  "checkout.guests": "Guests",
  "checkout.invalidPhone": "Enter a valid WhatsApp number for the selected country",
  "checkout.genericError": "Something went wrong - please try again.",
  "checkout.continueToPayment": "Continue to payment",
  "checkout.startingPayment": "Starting secure payment…",
  "checkout.heldTitle": "Your dates are held",
  "checkout.heldBodyPre":
    "We couldn't reach the payment provider. Your booking is held for",
  "checkout.heldBodyPost": "- retry the payment before it lapses.",
  "checkout.paymentCouldntStart": "Payment couldn't start. Please try again.",
  "checkout.retryPayment": "Retry payment",

  // Checkout refusal copy composed from a 409's machine-readable reasons (the
  // funnel's own localized half of the #82 contract - the dashboard keeps its
  // English `lib/conflict.ts`).
  "conflict.overlap": "Those dates were just taken. Please refresh and try again.",
  "conflict.minStay": "That stay is shorter than this unit's minimum.",
  "conflict.maxGuests": "That's more guests than this unit can host.",
  "conflict.unavailable": "This unit is no longer available for new bookings.",
  "conflict.generic": "Those dates can't be booked.",

  // Confirmation (page-spec §3.3).
  "confirm.title": "Your booking",
  "confirm.notFoundTitle": "Booking not found",
  "confirm.notFoundBody":
    "We couldn't find this booking. Check the link, or contact your host.",
  "confirm.errorTitle": "Something went wrong",
  "confirm.errorBody": "We couldn't load your booking just now. Please try again.",
  "confirm.allSet": "You're all set",
  "confirm.confirmedBody":
    "Your booking is confirmed. A copy is on its way to your email.",
  "confirm.stay": "Stay",
  "confirm.checkIn": "Check-in",
  "confirm.checkOut": "Check-out",
  "confirm.paidOnline": "Paid online",
  "confirm.balanceAtProperty": "Balance at the property",
  "confirm.sendWhatsapp": "Send WhatsApp confirmation",
  "confirm.pendingTitle": "Confirming your payment…",
  "confirm.pendingAria": "Confirming your payment",
  "confirm.pendingBody":
    "This can take a moment. This page updates automatically - no need to refresh.",
  "confirm.expiredTitle": "Your hold has lapsed",
  "confirm.expiredBody":
    "We only hold dates for a few minutes, and this hold has expired. Nothing was charged - please start a new booking.",
  "confirm.cancelledTitle": "This booking was cancelled",
  "confirm.cancelledBody": "If you think this is a mistake, contact your host.",
  "confirm.backHome": "← Back home",

  // Auth (page-spec §3.4) - public pages carry the switcher too (§2).
  "auth.signInSubtitle": "Sign in to your dashboard",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.signingIn": "Signing in…",
  "auth.signIn": "Sign in",
  "auth.invalidCredentials": "Invalid email or password",
  "auth.genericError": "Something went wrong - please try again",
  "auth.newToSambung": "New to Sambung?",
  "auth.createAccount": "Create an account",
  "auth.registerSubtitle": "Create your owner account",
  "auth.businessName": "Business name",
  "auth.creatingAccount": "Creating account…",
  "auth.createAccountBtn": "Create account",
  "auth.emailTaken": "Email already registered",
  "auth.alreadyHaveAccount": "Already have an account?",
  "auth.signInLink": "Sign in",
};

export type Messages = typeof en;
export type MessageKey = keyof Messages;
