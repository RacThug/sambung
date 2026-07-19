import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  countNights,
  createOwnerBookingRequestSchema,
  type CreateOwnerBookingResponse,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { conflictOf, describeConflict } from "../../lib/conflict";
import { formatIdr } from "../../lib/money";
import { issuesToFieldErrors } from "../../lib/forms";
import { addDays } from "./calendar-model";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

/** What the calendar hands the dialog when the owner clicks an empty day on a
 * Unit row: which Unit, its base rate (for the price hint), and the clicked date
 * as the default check-in. */
export interface CreateSeed {
  unitId: string;
  unitName: string;
  propertyName: string;
  basePriceIdr: number;
  checkIn: string;
}

type Mode = "manual_block" | "direct";

/**
 * The "block / walk-in" create dialog (page-spec §4.1, #50). One dialog, two
 * modes discriminated on source: a **Block** (maintenance / personal use, no guest
 * no price) or a **walk-in** (a real guest, born confirmed - guest name required,
 * price optional). Submits to `POST /bookings`; on success invalidates the
 * calendar so the new bar appears. Overlap comes back as the same 409 the guest
 * funnel gives (ADR-0011) - shown as a banner ("refresh, someone booked meanwhile").
 */
export function ManualBookingDialog({
  seed,
  onClose,
}: {
  seed: CreateSeed | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={seed !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {seed && (
          <ManualBookingForm
            // Reset all field state whenever a different cell opens the dialog.
            key={`${seed.unitId}:${seed.checkIn}`}
            seed={seed}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ManualBookingForm({
  seed,
  onDone,
}: {
  seed: CreateSeed;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("manual_block");
  const [checkIn, setCheckIn] = useState(seed.checkIn);
  const [checkOut, setCheckOut] = useState(addDays(seed.checkIn, 1));
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestCount, setGuestCount] = useState("");
  const [price, setPrice] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (body: unknown) =>
      api.post<CreateOwnerBookingResponse>("/bookings", body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["bookings"] });
      onDone();
    },
    onError: (err) => {
      // A 400 pins field errors; a 409 (overlap / archived) shows as a banner.
      if (err instanceof ApiError && err.status === 400) {
        setFieldErrors(err.fieldErrors);
      }
    },
  });

  const nights = checkOut > checkIn ? countNights(checkIn, checkOut) : 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    const body =
      mode === "manual_block"
        ? { source: "manual_block", unitId: seed.unitId, checkIn, checkOut }
        : {
            source: "direct",
            unitId: seed.unitId,
            checkIn,
            checkOut,
            guestName: guestName.trim(),
            ...(guestPhone.trim() && { guestPhone: guestPhone.trim() }),
            ...(guestEmail.trim() && { guestEmail: guestEmail.trim() }),
            ...(guestCount.trim() && { guestCount: Number(guestCount) }),
            ...(price.trim() && { totalPriceIdr: Number(price) }),
          };
    // Client-side validation mirrors the server schema, so obvious errors never
    // round-trip; the server re-validates regardless (a client is not trusted).
    const parsed = createOwnerBookingRequestSchema.safeParse(body);
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    save.mutate(parsed.data);
  };

  // A 409 (overlap / archived) comes back with a machine-readable slug; compose
  // our own copy from it (#82, ADR-0011), never the server's sentence. Any other
  // non-field error is a generic failure.
  const conflict = conflictOf(save.error);
  const bannerError = conflict
    ? describeConflict(conflict)
    : save.error instanceof ApiError && save.error.status !== 400
      ? "Something went wrong - please try again"
      : null;

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Add to {seed.unitName}</DialogTitle>
        <DialogDescription>{seed.propertyName}</DialogDescription>
      </DialogHeader>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <ModeButton
          active={mode === "manual_block"}
          onClick={() => setMode("manual_block")}
          title="Block"
          subtitle="Maintenance / personal use"
        />
        <ModeButton
          active={mode === "direct"}
          onClick={() => setMode("direct")}
          title="Walk-in"
          subtitle="A guest, paid offline"
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="checkIn">Check-in</Label>
          <Input
            id="checkIn"
            type="date"
            value={checkIn}
            onChange={(e) => setCheckIn(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="checkOut">Check-out</Label>
          <Input
            id="checkOut"
            type="date"
            min={addDays(checkIn, 1)}
            value={checkOut}
            onChange={(e) => setCheckOut(e.target.value)}
          />
          <FieldError msg={fieldErrors.checkOut} />
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {nights > 0
          ? `${nights} night${nights === 1 ? "" : "s"}`
          : "Check-out must be after check-in"}
      </p>

      {mode === "direct" && (
        <div className="mt-4 space-y-3">
          <div>
            <Label htmlFor="guestName">Guest name</Label>
            <Input
              id="guestName"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
            />
            <FieldError msg={fieldErrors.guestName} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="guestPhone">
                Phone <Optional />
              </Label>
              <Input
                id="guestPhone"
                value={guestPhone}
                onChange={(e) => setGuestPhone(e.target.value)}
              />
              <FieldError msg={fieldErrors.guestPhone} />
            </div>
            <div>
              <Label htmlFor="guestCount">
                Guests <Optional />
              </Label>
              <Input
                id="guestCount"
                type="number"
                min={1}
                value={guestCount}
                onChange={(e) => setGuestCount(e.target.value)}
              />
              <FieldError msg={fieldErrors.guestCount} />
            </div>
          </div>
          <div>
            <Label htmlFor="guestEmail">
              Email <Optional />
            </Label>
            <Input
              id="guestEmail"
              type="email"
              value={guestEmail}
              onChange={(e) => setGuestEmail(e.target.value)}
            />
            <FieldError msg={fieldErrors.guestEmail} />
          </div>
          <div>
            <Label htmlFor="price">
              Total price <Optional />
            </Label>
            <Input
              id="price"
              type="number"
              min={0}
              placeholder={nights > 0 ? String(seed.basePriceIdr * nights) : ""}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {nights > 0
                ? `Leave blank for ${formatIdr(seed.basePriceIdr * nights)} (${formatIdr(seed.basePriceIdr)} × ${nights})`
                : "Defaults to the base rate × nights"}
            </p>
            <FieldError msg={fieldErrors.totalPriceIdr} />
          </div>
        </div>
      )}

      {bannerError && (
        <p className="mt-4 text-sm text-destructive">{bannerError}</p>
      )}

      <DialogFooter className="mt-6">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending
            ? "Saving…"
            : mode === "manual_block"
              ? "Block dates"
              : "Add walk-in"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ModeButton({
  active,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-3 py-2 text-left transition-colors ${
        active
          ? "border-primary bg-primary/10"
          : "border-input hover:bg-muted"
      }`}
    >
      <span className="block text-sm font-medium text-foreground">{title}</span>
      <span className="block text-xs text-muted-foreground">{subtitle}</span>
    </button>
  );
}

const Optional = () => (
  <span className="text-xs font-normal text-muted-foreground">(optional)</span>
);

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-xs text-destructive">{msg}</p>;
}
