import { z } from "zod";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

// ?from=&to= for the availability picker (M2). Shape-only for now: half-open
// range semantics (from < to) belong to the picker logic, not URL parsing.
// .catch(undefined) makes a malformed date degrade to "no date picked"
// instead of an error page - deep links should never hard-fail the funnel.
export const propertySearchSchema = z.object({
  from: z.string().regex(isoDate).optional().catch(undefined),
  to: z.string().regex(isoDate).optional().catch(undefined),
});
