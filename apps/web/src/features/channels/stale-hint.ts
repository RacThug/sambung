/**
 * What a stale feed means, in the owner's words - one string, both surfaces
 * (REQ-AV-04, spec UX-05's rule applied to the phrase it left copied).
 *
 * The calendar says it about the fleet and the workbench says it about one feed,
 * but it is the same diagnosis: the pull is not running. Two wordings would be two
 * claims, and the reader has no way to know they were meant to be one.
 *
 * A fragment rather than a sentence, so each caller punctuates its own line.
 */
export const STALE_HINT = "syncing may have stopped";
