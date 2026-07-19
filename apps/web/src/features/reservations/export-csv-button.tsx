import { useState } from "react";
import type { ReservationFilters } from "./use-reservations";
import { downloadReservationsCsv } from "./reservations-export";

/**
 * "Export CSV" (page-spec §4.2). Downloads the reservations list under the CURRENT
 * filters (#59) - it takes the same `filters` the page queries with, so the file
 * matches the table the owner sees. Disabled while the fetch is in flight; a failed
 * download shows a short inline message rather than a silent no-op.
 */
export function ExportCsvButton({ filters }: { filters: ReservationFilters }) {
  const [isExporting, setIsExporting] = useState(false);
  const [failed, setFailed] = useState(false);

  const onExport = async () => {
    setIsExporting(true);
    setFailed(false);
    try {
      await downloadReservationsCsv(filters);
    } catch {
      setFailed(true);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void onExport()}
        disabled={isExporting}
        className="rounded-md border border-input px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
      >
        {isExporting ? "Exporting…" : "Export CSV"}
      </button>
      {failed && (
        <p className="text-xs text-destructive">
          Export failed. Please try again.
        </p>
      )}
    </div>
  );
}
