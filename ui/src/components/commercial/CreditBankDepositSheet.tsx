import { useEffect, useState } from "react";
import { centsFromMoneyInput, moneyInputFromCents } from "../../lib/collect";
import {
  CreditBankFinalizationError,
  depositCreditBank,
  readPendingCreditBankDeposit,
  type PackageSaleTender,
  type PatientCreditBank,
} from "../../lib/commercial-engine";
import { resolveSessionRoles } from "../../lib/practice-roles";

const TENDERS: Array<{ code: PackageSaleTender; label: string }> = [
  { code: "CASH", label: "Cash" },
  { code: "CHECK", label: "Check" },
  { code: "CARD_MANUAL", label: "Card — manual entry" },
];

export function CreditBankDepositSheet({
  patientReference,
  patientName,
  onClose,
  onDeposited,
}: {
  patientReference: string;
  patientName?: string;
  onClose: () => void;
  onDeposited?: (creditBank: PatientCreditBank) => void;
}) {
  const [pending] = useState(() => readPendingCreditBankDeposit(patientReference));
  const [depositInput, setDepositInput] = useState(() => moneyInputFromCents(pending?.depositCents ?? 0));
  const [bonusInput, setBonusInput] = useState(() => moneyInputFromCents(pending?.bonusCents ?? 0));
  const [bonusReason, setBonusReason] = useState(pending?.bonusReason ?? "");
  const [tender, setTender] = useState<PackageSaleTender>(pending?.tender ?? "CASH");
  const [paidInvoiceReference, setPaidInvoiceReference] = useState(pending?.invoiceReference);
  const [canBonus, setCanBonus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    resolveSessionRoles()
      .then(({ roles }) => !cancelled && setCanBonus(roles.includes("practice-admin")))
      .catch((cause) => !cancelled && setError(messageOf(cause)));
    return () => { cancelled = true; };
  }, []);

  async function deposit() {
    const depositCents = centsFromMoneyInput(depositInput);
    const bonusCents = centsFromMoneyInput(bonusInput);
    if (!depositCents || bonusCents === undefined) {
      setError("Enter a positive deposit and a valid bonus amount.");
      return;
    }
    if (bonusCents > 0 && (!canBonus || !bonusReason.trim())) {
      setError("Practice-admin role and a reason are required for promotional bonus credit.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const creditBank = await depositCreditBank({
        patientReference,
        depositCents,
        bonusCents,
        ...(bonusCents > 0 ? { bonusReason: bonusReason.trim() } : {}),
        tender,
        ...(paidInvoiceReference ? { paidInvoiceReference } : {}),
      });
      onDeposited?.(creditBank);
      onClose();
    } catch (cause) {
      if (cause instanceof CreditBankFinalizationError) setPaidInvoiceReference(cause.invoiceReference);
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside role="dialog" aria-modal="true" aria-label="Deposit to Credit Bank" className="fixed inset-y-0 right-0 z-[70] flex w-[min(560px,100vw)] flex-col overflow-y-auto border-l border-white/15 bg-[#0c0c18] text-white shadow-2xl">
      <header className="flex items-start justify-between border-b border-white/10 px-5 py-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-300/70">Stored value</p>
          <h2 className="mt-1 text-xl font-semibold">Deposit to Credit Bank</h2>
          <p className="text-sm text-white/50">{patientName ?? patientReference}</p>
        </div>
        <button type="button" aria-label="Close Credit Bank deposit" onClick={onClose}>✕</button>
      </header>
      <div className="grid flex-1 gap-5 p-5">
        <label className="grid gap-2 text-sm font-semibold text-white/70">
          Deposit amount
          <input aria-label="Credit Bank deposit amount" inputMode="decimal" disabled={Boolean(paidInvoiceReference)} value={depositInput} onChange={(event) => setDepositInput(event.target.value)} className="scheduler-input" />
        </label>
        {canBonus && (
          <section className="grid gap-3 rounded border border-amber-300/20 bg-amber-950/15 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-amber-200/70">Optional promotional bonus</p>
            <label className="grid gap-2 text-sm font-semibold text-white/70">
              Bonus amount
              <input aria-label="Credit Bank bonus amount" inputMode="decimal" disabled={Boolean(paidInvoiceReference)} value={bonusInput} onChange={(event) => setBonusInput(event.target.value)} className="scheduler-input" />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-white/70">
              Bonus reason
              <input aria-label="Credit Bank bonus reason" disabled={Boolean(paidInvoiceReference)} value={bonusReason} onChange={(event) => setBonusReason(event.target.value)} className="scheduler-input" placeholder="Required when a bonus is added" />
            </label>
          </section>
        )}
        <fieldset>
          <legend className="mb-2 text-xs font-bold uppercase tracking-wide text-white/40">Payment collected as</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {TENDERS.map((entry) => (
              <button key={entry.code} type="button" disabled={Boolean(paidInvoiceReference)} aria-pressed={tender === entry.code} onClick={() => setTender(entry.code)} className={`rounded border px-3 py-2 text-sm disabled:opacity-40 ${tender === entry.code ? "border-emerald-400 bg-emerald-700 font-bold" : "border-white/15 text-white/60"}`}>
                {entry.label}
              </button>
            ))}
          </div>
        </fieldset>
        <p className="text-xs leading-relaxed text-white/45">Only the paid deposit is cash collected. Promotional bonus credit is recorded separately and never linked to the funding Invoice.</p>
        {error && <div role="alert" className="rounded border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-white/10 p-4">
        <button type="button" onClick={onClose} className="rounded border border-white/15 px-4 py-2 text-white/65">Cancel</button>
        <button type="button" disabled={busy} onClick={() => void deposit()} className="rounded bg-emerald-700 px-5 py-2 font-bold disabled:opacity-40">
          {busy ? (paidInvoiceReference ? "Funding…" : "Collecting…") : paidInvoiceReference ? "Retry Credit Bank funding" : "Collect and fund"}
        </button>
      </footer>
    </aside>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
