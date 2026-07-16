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
 */
export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string>;

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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res = await send(method, path, body);

  // 401-retry: one silent refresh, then one retry; a second 401 ends the
  // session. Auth endpoints are exempt — their 401s are answers ("wrong
  // password", "no cookie"), not expired-token noise. (page-spec §2)
  if (res.status === 401 && !path.startsWith("/auth")) {
    if (await refreshSession()) {
      res = await send(method, path, body);
    }
    if (res.status === 401) {
      clearSession();
    }
  }

  if (!res.ok) {
    const envelope = (await res.json().catch(() => ({}))) as ErrorEnvelope;
    throw new ApiError(res.status, envelope);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: (path: string) => request<undefined>("DELETE", path),
};
