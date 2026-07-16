import { getRouteApi } from "@tanstack/react-router";

const route = getRouteApi("/p/$slug");

// Scaffold property page. Real content (photos, units, availability picker)
// lands in M1/M2 - this exists to pin the funnel URL shape: /p/:slug?from=&to=
export function PropertyPage() {
  const { slug } = route.useParams();
  const { from, to } = route.useSearch();

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold text-brand-600">{slug}</h1>
      <p className="mt-2 text-gray-600">Property page - coming in M1.</p>
      <p className="mt-2 text-gray-500">
        Dates: {from ?? "-"} → {to ?? "-"}
      </p>
    </main>
  );
}
