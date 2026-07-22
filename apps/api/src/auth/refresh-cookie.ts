import type { Response } from 'express';

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
 */
export const REFRESH_COOKIE = 'refresh_token';
export const REFRESH_PATH = '/api/auth';
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: REFRESH_PATH,
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
}
