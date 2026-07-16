import type { z } from "zod";

/**
 * First zod message per field, keyed by dotted path - the shape form inputs
 * render next to themselves (page-spec §2 error surfaces). Server-side 400s
 * arrive pre-mapped the same way via ApiError.fieldErrors.
 */
export function issuesToFieldErrors(
  issues: z.ZodIssue[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    errors[issue.path.join(".")] ??= issue.message;
  }
  return errors;
}
