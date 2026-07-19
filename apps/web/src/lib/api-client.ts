// Thin fetch wrapper. All data flows through the NestJS API — the SPA never
// touches the DB. (CLAUDE.md invariant #1)
import { clearSession, getAccessToken, refreshSession } from "./auth";

const BASE_URL = "/api";

interface ErrorEnvelope {
  statusCode?: number;
  message?: string | Array<{ path: string; message: string }>;
  error?: string;
}

/**
 * A non-2xx API response. `fieldErrors` maps zod 400s (`message[].path`) to
 * inputs so forms can render errors next to the field that caused them.
 * (page-spec §2 error surfaces)
 *
 * `body` is the raw parsed envelope, kept so a caller can read a 409's structured
 * payload - the machine-readable `code` slug + its typed detail (a delete guard's
 * `count`, a refusal's `reasons`) - via `conflictOf()` (lib/conflict). The web
 * switches on that slug and renders its own copy; server prose is never shown
 * (#82, api-spec §8.2).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string>;
  readonly body: unknown;

  constructor(status: number, envelope: ErrorEnvelope) {
    const fieldErrors: Record<string, string> = {};
    let message = `API error ${status}`;
    if (typeof envelope.message === "string") {
      message = envelope.message;
    } else if (Array.isArray(envelope.message)) {
      for (const issue of envelope.message) {
        fieldErrors[issue.path] ??= issue.message;
      }
      message = "Validation failed";
    }
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.body = envelope;
  }
}

async function send(method: string, path: string, body?: unknown) {
  const token = getAccessToken();
  return fetch(`${BASE_URL}${path}`, {
    method,
    credentials: "include",
    headers: {
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/**
 * Send with the session's 401-retry, returning the raw Response. One silent
 * refresh, then one retry; a second 401 ends the session. Auth endpoints are
 * exempt — their 401s are answers ("wrong password", "no cookie"), not
 * expired-token noise. (page-spec §2) Shared by the JSON `request` and the binary
 * `getBlob` so a CSV download refreshes exactly like every other authed read.
 */
async function sendWithSession(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  let res = await send(method, path, body);

  if (res.status === 401 && !path.startsWith("/auth")) {
    if (await refreshSession()) {
      res = await send(method, path, body);
    }
    if (res.status === 401) {
      // Second 401: the session is gone for real - log out to /login,
      // remembering where the user was. (page-spec §2)
      clearSession();
      if (window.location.pathname.startsWith("/app")) {
        const next = window.location.pathname + window.location.search;
        window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      }
    }
  }
  return res;
}

async function errorFrom(res: Response): Promise<ApiError> {
  const envelope = (await res.json().catch(() => ({}))) as ErrorEnvelope;
  return new ApiError(res.status, envelope);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await sendWithSession(method, path, body);
  if (!res.ok) {
    throw await errorFrom(res);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

/**
 * A GET whose body is not JSON — the reservations CSV export (#59). It carries the
 * Bearer token (so a plain `<a href>` can't stand in) and the same 401-retry as
 * `request`, but reads the response as a Blob for the browser to download. A non-2xx
 * still surfaces as an `ApiError` off the JSON error envelope.
 */
async function getBlob(path: string): Promise<Blob> {
  const res = await sendWithSession("GET", path);
  if (!res.ok) {
    throw await errorFrom(res);
  }
  return res.blob();
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  getBlob,
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  // Generic: a 204 delete resolves to undefined, a 200 delete (channel disconnect,
  // which returns how many imported bookings were kept - api-spec §7.4) to its body.
  delete: <T = undefined>(path: string) => request<T>("DELETE", path),
};
