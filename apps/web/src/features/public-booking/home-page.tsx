import { useQuery } from "@tanstack/react-query";
import type { HealthResponse } from "@sambung/shared";
import { api } from "../../lib/api-client";
import { Wordmark } from "@/components/wordmark";
import { useI18n } from "@/i18n/context";

// Scaffold landing page. Proves the full wire: React Query → API client →
// NestJS /api/health → shared contract type. Real booking funnel lands in M1/M2.
export function HomePage() {
  const { t } = useI18n();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<HealthResponse>("/health"),
  });

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1>
        <Wordmark className="text-3xl" />
      </h1>
      <p className="mt-2 text-muted-foreground">{t("home.tagline")}</p>

      <section className="mt-6 rounded-lg border border-border p-4">
        <h2 className="font-semibold">{t("home.apiHealth")}</h2>
        {isLoading && <p className="text-muted-foreground">{t("home.checking")}</p>}
        {isError && <p className="text-destructive">{t("home.apiUnreachable")}</p>}
        {data && (
          <p className="text-success">
            {data.service}: {data.status}
          </p>
        )}
      </section>
    </main>
  );
}
