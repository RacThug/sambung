import type { Response } from 'express';
import { isDeployment } from '../deployment-env';

/**
 * The refresh cookie, in one place (architecture §4.4).
 *
 * httpOnly + Secure, scoped to `/api/auth` so it is only ever sent to the
 * refresh endpoint. JS cannot read it, so an XSS cannot steal it.
 *
 * Extracted from AuthController when #57 added a SECOND way to start a session
 * (accepting a staff invite). Two copies of these five options is one copy too
 * many: a divergent `path` does not fail loudly - it silently logs the user out
 * fifteen minutes later, when the access token expires and the refresh call
 * arrives without a cookie.
 *
 * `Secure` was the SECOND consumer of `NODE_ENV === 'production'`, and it was
 * inert for the same reason the boot guards were: nothing sets that variable
 * (#193). A deployment that forgot it shipped a session cookie a plain `http://`
 * request to the same host would carry. It now asks the one authority - a proven
 * local sandbox (dev, e2e) is plain http and must stay non-Secure, everything
 * else is Secure.
 */
export const REFRESH_COOKIE = 'refresh_token';
export const REFRESH_PATH = '/api/auth';
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isDeployment(process.env),
    sameSite: 'lax',
    path: REFRESH_PATH,
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
}
