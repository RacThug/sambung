import { PageHeader } from "@/components/page-header";
import { SyncConflictsSection } from "../channels/sync-conflicts-section";
import { LapsedPaymentsSection } from "../payments/lapsed-payments-section";

/**
 * The operations inbox - `/app/inbox`. One page for everything where Sambung took
 * the safe action and now needs the owner to finish the job in the real world:
 *
 *  - **Calendar conflicts** (#38, ADR-0027) - an OTA sold nights already booked
 *    here, so the import was refused rather than double-booking the room.
 *  - **Payments needing attention** (#120, ADR-0022) - a guest settled after their
 *    hold lapsed, so the money is captured but the dates are not held.
 *
 * They share a page rather than a nav item each because they share a shape: the
 * system is *correct* and *stuck*, and only a human can unstick it. Two nav items
 * would mean two places to remember to check, and an owner who checks neither.
 *
 * Conflicts come first: a double-sold room has a guest arriving at a door, which
 * beats a refund on the clock.
 */
export function InboxPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Inbox" />
      <div className="mt-6 space-y-10">
        <SyncConflictsSection />
        <LapsedPaymentsSection />
      </div>
    </div>
  );
}
