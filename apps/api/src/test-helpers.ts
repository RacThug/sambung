import { randomUUID } from 'node:crypto';

/**
 * A throwaway public address for a fixture property.
 *
 * `property.slug` is NOT NULL and GLOBALLY unique (#46), so every fixture that
 * inserts a property directly needs one, even where no test asserts on it.
 * Random per call because these specs run repeatedly against the same dev
 * database - a fixed slug would collide with the previous run rather than with
 * anything the test is trying to prove.
 *
 * Duplicated from packages/db/test/helpers.ts on purpose: that file is inside
 * another package's test folder, which this app cannot import. A one-line test
 * helper is not worth a shared package.
 */
export const testSlug = (): string => `test-${randomUUID()}`;
