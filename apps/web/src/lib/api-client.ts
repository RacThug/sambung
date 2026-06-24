// Thin fetch wrapper. All data flows through the NestJS API — the SPA never
// touches the DB. (CLAUDE.md invariant #1). Access-token attach + refresh-on-401
// arrive with auth in M0 #5.
const BASE_URL = "/api";

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`API ${res.status} on ${path}`);
  }
  return (await res.json()) as T;
}
