import { useQuery } from "@tanstack/react-query";
import type { HealthResponse } from "@sambung/shared";
import { api } from "../../lib/api-client";

// Scaffold landing page. Proves the full wire: React Query → API client →
// NestJS /api/health → shared contract type. Real booking funnel lands in M1/M2.
export function HomePage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<HealthResponse>("/health"),
  });

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold text-brand-600">Sambung</h1>
      <p className="mt-2 text-gray-600">
        Direct-booking engine + lightweight channel manager.
      </p>

      <section className="mt-6 rounded-lg border border-gray-200 p-4">
        <h2 className="font-semibold">API health</h2>
        {isLoading && <p className="text-gray-500">Checking…</p>}
        {isError && <p className="text-red-600">API unreachable</p>}
        {data && (
          <p className="text-green-700">
            {data.service}: {data.status}
          </p>
        )}
      </section>
    </main>
  );
}
