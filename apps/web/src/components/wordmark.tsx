import { cn } from "@/lib/utils";

/** The Sambung wordmark: lowercase `sambung`, Fraunces semibold, terracotta
 * (design-system.md §1). The brand's one typographic mark - there is no drawn
 * symbol, deliberately. Context/size come from `className`; the defaults suit an
 * inline header lockup. A pure mark - callers wrap it in a Link where it links. */
function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-display text-xl font-semibold lowercase tracking-tight text-primary",
        className,
      )}
    >
      sambung
    </span>
  );
}

export { Wordmark };
