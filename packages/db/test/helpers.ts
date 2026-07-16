import { expect } from "vitest";
import { pgError } from "../src/index";

/**
 * Assert that a statement is rejected by Postgres with the given SQLSTATE code
 * (and, optionally, by the exact named constraint). Stronger than matching on
 * message text: we assert the DB refused it for precisely the reason we built.
 */
export async function expectDbError(
  p: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught, "expected the statement to be rejected").toBeDefined();
  const info = pgError(caught);
  expect(info?.code, `expected SQLSTATE ${code}, got: ${String(caught)}`).toBe(
    code,
  );
  if (constraint) {
    expect(info?.constraint).toBe(constraint);
  }
}
