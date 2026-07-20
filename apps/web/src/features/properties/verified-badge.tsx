// The FR-PROP-3 badge: shown wherever `verified` (or its live preview) is true.
// `label` lets the public funnel pass a localized word (ADR-0024); the dashboard
// omits it and gets the English default.
export function VerifiedBadge({ label = "Verified" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
      ✓ {label}
    </span>
  );
}
