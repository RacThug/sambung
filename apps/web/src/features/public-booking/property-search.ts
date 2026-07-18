import { z } from "zod";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

// ?from=&to=&unit= for the availability picker (M2, #47). Shape-only: half-open
// range semantics (from < to, the night cap) belong to the picker logic and the
// server quote (api-spec §5.1), not URL parsing. `unit` preselects which unit's
// picker is open (page-spec §3.1); the quote endpoint addresses a unit by this id.
// .catch(undefined) makes a malformed value degrade to "nothing picked" instead
// of an error page - a shared deep link should never hard-fail the funnel.
export const propertySearchSchema = z.object({
  from: z.string().regex(isoDate).optional().catch(undefined),
  to: z.string().regex(isoDate).optional().catch(undefined),
  unit: z.string().uuid().optional().catch(undefined),
});
