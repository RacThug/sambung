import type { Response } from 'express';
import { setRefreshCookie } from './refresh-cookie';

/**
 * The `Secure` attribute on the refresh cookie is the SECOND consumer of
 * "is this production" (#193 states validate-env is the only one; it is not),
 * and it was gated on the same `NODE_ENV` nothing in this repo sets - so a
 * deployment that forgot the variable shipped a session cookie that a plain
 * `http://` request to the same host would carry.
 *
 * It now reads the same deployment evidence the boot guard does: `secure` iff
 * the process is not a proven local sandbox. Driven through a fake Response,
 * so this asserts the option actually handed to express.
 */
function capture(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const saved = { ...process.env };
  const calls: Record<string, unknown>[] = [];
  const res = {
    cookie: (_name: string, _value: string, options: Record<string, unknown>) =>
      calls.push(options),
  } as unknown as Response;
  try {
    process.env = env;
    setRefreshCookie(res, 'token');
  } finally {
    process.env = saved;
  }
  return calls[0];
}

const LOCAL = {
  WEB_BASE_URL: 'http://localhost:5173',
  STORAGE_PUBLIC_BASE_URL: 'http://sambung-photos.web.garage.localhost:3902',
} satisfies NodeJS.ProcessEnv;

describe('setRefreshCookie', () => {
  it('is httpOnly, lax and scoped to the refresh path everywhere', () => {
    const options = capture(LOCAL);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/api/auth');
  });

  it('is not Secure on a proven local sandbox (dev + e2e are plain http)', () => {
    expect(capture(LOCAL).secure).toBe(false);
  });

  it('is Secure when NODE_ENV declares production', () => {
    expect(capture({ ...LOCAL, NODE_ENV: 'production' }).secure).toBe(true);
  });

  it('is Secure on a deployment that forgot NODE_ENV', () => {
    expect(
      capture({
        WEB_BASE_URL: 'https://sambung.example',
        STORAGE_PUBLIC_BASE_URL: 'https://photos.sambung.example',
      }).secure,
    ).toBe(true);
  });
});
