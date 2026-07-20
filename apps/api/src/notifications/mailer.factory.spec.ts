import type { ConfigService } from '@nestjs/config';
import { LogMailer } from './log-mailer';
import { createMailer } from './mailer.factory';
import { ResendMailer } from './resend-mailer';

/**
 * The env-driven binding (#119). The factory picks the REAL adapter only when the
 * provider is fully configured, and otherwise the zero-cost `LogMailer` - so dev,
 * the whole test suite, and an unconfigured prod all stay off any live provider
 * (invariant #8) with no call-site change. This is the seam that keeps "no suite
 * touches a live provider" true by construction: the test env sets no
 * RESEND_API_KEY, so the app boots on LogMailer.
 */
describe('createMailer', () => {
  const config = (env: Record<string, string | undefined>) =>
    ({ get: (key: string) => env[key] }) as unknown as ConfigService;

  it('returns LogMailer when no provider is configured', () => {
    expect(createMailer(config({}))).toBeInstanceOf(LogMailer);
  });

  it('returns LogMailer when only the API key is set (no from address)', () => {
    expect(createMailer(config({ RESEND_API_KEY: 're_x' }))).toBeInstanceOf(
      LogMailer,
    );
  });

  it('returns LogMailer when only the from address is set (no API key)', () => {
    expect(createMailer(config({ MAIL_FROM: 'a@b.dev' }))).toBeInstanceOf(
      LogMailer,
    );
  });

  it('returns the ResendMailer when API key AND from are both configured', () => {
    expect(
      createMailer(config({ RESEND_API_KEY: 're_x', MAIL_FROM: 'a@b.dev' })),
    ).toBeInstanceOf(ResendMailer);
  });
});
