import { useState } from "react";
import {
  spendCreditBank,
  type PatientCreditBank,
} from "../../lib/commercial-engine";

export function CheckoutBankCredit({
  patientReference,
  chargeItemReference,
  amountCents,
  creditBank,
  loading = false,
  loadError,
  onSpent,
}: {
  patientReference: string;
  chargeItemReference: string;
  amountCents: number;
  creditBank?: PatientCreditBank;
  loading?: boolean;
  loadError?: string;
  onSpent?: (creditBank: PatientCreditBank) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();

  if (loading) return null;
  if (!creditBank) return loadError
    ? <p role="alert" className="mt-2 text-xs text-red-200">{loadError}</p>
    : null;
  if (creditBank.balanceCents <= 0 && !error && !done) return null;
  const sufficient = creditBank.balanceCents >= amountCents;

  async function apply() {
    if (!sufficient || done) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await spendCreditBank({ patientReference, chargeItemReference });
      setDone(`Credit Bank applied · ${result.invoiceReference}`);
      onSpent?.(result.creditBank);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 grid gap-1">
      <button type="button" disabled={busy || Boolean(done) || !sufficient} onClick={() => void apply()} className="rounded border border-emerald-300/25 bg-emerald-950/20 px-3 py-2 text-left text-xs text-emerald-100 disabled:opacity-40">
        <strong>Credit Bank available: {money(creditBank.balanceCents)}</strong>
        <span className="ml-2 font-bold">{sufficient ? `Apply ${money(amountCents)}` : `Insufficient for ${money(amountCents)}`}</span>
      </button>
      {done && <p role="status" className="text-xs text-emerald-300">{done}</p>}
      {error && <p role="alert" className="text-xs text-red-200">{error}</p>}
    </div>
  );
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
