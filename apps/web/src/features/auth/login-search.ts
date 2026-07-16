import { z } from "zod";

// ?next= is where the auth guard bounced from. Only same-app paths are
// allowed: a full URL (or a protocol-relative "//host") here would be an
// open redirect straight off the login form.
export const loginSearchSchema = z.object({
  next: z
    .string()
    .regex(/^\/(?!\/)/)
    .optional()
    .catch(undefined),
});
