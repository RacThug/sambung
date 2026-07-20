/**
 * @sambung/shared — the FE⇄BE contract.
 *
 * Request/response types + zod schemas live here. The API validates incoming
 * data against these schemas; the web app imports the same types so a wrong
 * field name is a compile error, not a runtime surprise. One source of truth
 * for the API shape. (architecture.md §2)
 *
 * This file seeds the pattern with a couple of shared primitives. Real
 * per-feature contracts arrive with their milestones, each in its own file.
 *
 * The booking vocabulary (`bookingStatusSchema` / `bookingSourceSchema`) used to
 * live here as M0 scaffolding and was deleted unused, because it had drifted
 * from the database and would have misled the milestone that finally needed it.
 * M2 defines it in ./booking, beside the endpoints that use it, pinned to the
 * pgEnum per api-spec §8.6.
 */
import { z } from "zod";

export * from "./availability";
export * from "./auth";
export * from "./booking";
export * from "./booking-confirmation";
export * from "./booking-list";
export * from "./channel";
export * from "./conflict";
export * from "./money";
export * from "./payment";
export * from "./photo";
export * from "./property";
export * from "./public-property";
export * from "./slug";
export * from "./unit";

/** Health-check response shape, shared by API and any client probe. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  timestamp: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
