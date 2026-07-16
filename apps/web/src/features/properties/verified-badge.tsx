// The FR-PROP-3 badge: shown wherever `verified` (or its live preview) is true.
export function VerifiedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
      ✓ Verified
    </span>
  );
}
