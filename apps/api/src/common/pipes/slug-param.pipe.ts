import { NotFoundException, PipeTransform } from '@nestjs/common';
import { SLUG_PATTERN } from '@sambung/shared';

/**
 * Validate a `:slug` path param at the boundary (#46 review).
 *
 * WHY IT EXISTS. Without it, `/public/properties/%00` decodes to a NUL byte,
 * reaches Postgres, and comes back 22021 (invalid byte sequence) - which is not
 * a constraint violation, so DbErrorInterceptor doesn't map it, so it is a 500.
 * On the one route with no authentication in front of it. The controller used to
 * claim "an unknown or malformed one is simply a 404"; it wasn't, and the claim
 * was the bug. "Trust no external input" (CLAUDE.md) covers a param from a URL
 * bar exactly as much as it covers a request body - the slug was the only
 * free-text path param in the API without a pipe on it.
 *
 * WHY 404, NOT THE 400 api-spec §1 MANDATES FOR A MALFORMED UUID. A string that
 * cannot match SLUG_PATTERN cannot exist in the column - `property_slug_format`
 * guarantees it - so "no such page" is not a euphemism here, it is the true
 * answer, reached without a lookup. It is also the answer the guest needs: a
 * mistyped link should read as a dead link, not as a complaint about their
 * input. The UUID rule's actual principle - refuse before touching the database -
 * is upheld either way.
 */
export class SlugParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    // SLUG_PATTERN is anchored and carries no /g flag, so `test` is stateless -
    // a /g regex here would hold lastIndex between requests and start failing
    // every other call.
    if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) {
      throw new NotFoundException('Property not found');
    }
    return value;
  }
}
