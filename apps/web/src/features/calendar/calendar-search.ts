import { z } from "zod";

/**
 * `/app/calendar` URL state (page-spec §4.1): `?from&to&propertyId`. A filtered
 * view is a shareable URL. Search params are external input - a pasted `?from=oops`
 * must open the current month, not crash the home page - so each degrades to
 * `undefined` on a bad value (the funnel's `.catch(undefined)` rule), and the page
 * fills the default month. `from`/`to` are half-open `[from, to)`.
 */
export const calendarSearchSchema = z.object({
  from: z.string().date().optional().catch(undefined),
  to: z.string().date().optional().catch(undefined),
  propertyId: z.string().uuid().optional().catch(undefined),
});
export type CalendarSearch = z.infer<typeof calendarSearchSchema>;
