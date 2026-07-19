import { SOURCE_META, SOURCE_ORDER } from "./calendar-model";

/**
 * The colour key (page-spec §4.1): one swatch per source, plus the hatched
 * "hold". The swatch is the exact solid colour the bars use, so the legend and
 * the grid can't drift. This is the non-colour channel a colour-blind owner reads
 * the calendar by (clashes are prevented at write time regardless).
 */
export function SourceLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {SOURCE_ORDER.map((source) => (
        <li key={source} className="flex items-center gap-1.5">
          <span
            className="size-3 rounded-sm"
            style={{ backgroundColor: SOURCE_META[source].cssVar }}
          />
          {SOURCE_META[source].label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span
          className="size-3 rounded-sm border border-border"
          style={{
            backgroundColor: "var(--source-direct)",
            backgroundImage:
              "repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,.6) 2px, rgba(255,255,255,.6) 4px)",
          }}
        />
        Hold (unpaid)
      </li>
    </ul>
  );
}
