import { createBookingRequestSchema } from '@sambung/shared';
import { isValidPhoneNumber } from 'libphonenumber-js/min';

/**
 * The API-side guest-checkout body schema (#124): the shared **shape** gate plus a
 * server-only **validity** gate.
 *
 * `createBookingRequestSchema` (packages/shared, both sides import it) enforces only
 * the E.164 *shape* - `^\+[1-9]\d{7,14}$`. That is deliberate: `libphonenumber-js`
 * must not leak into the shared contract or the web bundle (it ships to the public
 * funnel bundle alone). But "validate all external input at the boundary" means the
 * server, not just the SPA, must reject an implausible number - a crafted request
 * can post a shape-valid-but-wrong-length national part (e.g. `+62812345` for +62).
 *
 * So we LAYER a per-country `.refine()` here, in apps/api only. The shared schema
 * stays the shape gate; this is the validity gate. The dependency is server-side
 * only - `packages/shared` and `apps/web`'s package.json are untouched.
 *
 * We use the SAME `/min` metadata build the funnel validates with (apps/web's
 * phone.ts), so any number the checkout's own libphonenumber accepted, this accepts
 * too - the funnel's behaviour is unchanged by construction (AC #2). `.refine()`
 * over the existing ZodEffects keeps the output type (`CreateBookingRequest`)
 * identical, and a failure renders as the same field-scoped 400 the shape gate does.
 */
export const apiCreateBookingRequestSchema = createBookingRequestSchema.refine(
  (b) => isValidPhoneNumber(b.guestPhone),
  {
    message: 'must be a valid phone number for its country',
    path: ['guestPhone'],
  },
);
