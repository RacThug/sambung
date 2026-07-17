import { z } from "zod";

// ?next= is where the auth guard bounced from; /login and /register share it.
// Only same-app paths are allowed: a full URL (or a protocol-relative
// "//host") here would be an open redirect straight off the auth forms.
export const authSearchSchema = z.object({
  next: z
    .string()
    .regex(/^\/(?!\/)/)
    .optional()
    .catch(undefined),
});
