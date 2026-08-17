import { useState } from "react";
import {
  attestPackageCashRefund,
  convertPackageToCreditBank,
  type PatientCreditBank,
  type PatientPackageInstance,
} from "../../lib/commercial-engine";
import { money, useDockedPanel } from "./panel-shared";

export function BalancePanel({
  patientReference,
  packages,
  creditBank,
  canAdminister,
  onPackageChanged,
  onClose,
}: {
  patientReference: string;
  packages: readonly PatientPackageInstance[];
  creditBank: PatientCreditBank;
  canAdminister: boolean;
  onPackageChanged: (packageInstance: PatientPackageInstance, creditBank?: PatientCreditBank) => void;
  onClose: () => void;
}) {
  const { dialogRef, initialFocusRef, titleId } = useDockedPanel(onClose);
  return (
    <aside ref={dialogRef} role="dialog" aria-modal="true" aria-label="Prepaid balances" aria-labelledby={titleId} className="fixed inset-y-0 right-0 z-[65] flex w-[min(720px,100vw)] flex-col overflow-y-auto border-l border-white/15 bg-[#0c0c18] text-white shadow-2xl">
      <header className="flex items-start justify-between border-b border-white/10 px-5 py-4">
        <div><p id={titleId} aria-label="Prepaid balances" className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300/70">Prepaid care</p><h2 className="mt-1 text-xl font-semibold">Balances and history</h2></div>
        <button ref={initialFocusRef} type="button" aria-label="Close prepaid balances" onClick={onClose}>✕</button>
      </header>
      <div className="grid gap-4 p-5">
        <CreditBankHistory creditBank={creditBank} />
        {packages.map((instance) => (
          <article key={instance.id} className="rounded border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{instance.name}</h3>
                <p className="mt-1 text-sm text-white/50">Expires {localDate(instance.expiryDate)} · sold on Invoice/{instance.sourceSaleInvoiceId}</p>
                <p className="mt-1 text-xs text-white/45">Frozen refund policy: {refundPolicyLabel(instance.refundPolicy)}</p>
              </div>
              <span className="rounded-full border border-cyan-300/30 bg-cyan-950/30 px-3 py-1 text-sm font-bold text-cyan-100">{instance.remainingSessions} of {instance.sessionCount} remaining</span>
            </div>
            {canAdminister && instance.remainingSessions > 0 && instance.refundPolicy !== "non_refundable" && (
              <PackageLifecycleAction
                patientReference={patientReference}
                packageInstance={instance}
                onChanged={onPackageChanged}
              />
            )}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[620px] text-left text-xs">
                <thead className="text-white/40"><tr><th className="pb-2">Date</th><th className="pb-2">Entry</th><th className="pb-2 text-right">Sessions</th><th className="pb-2">Linked record</th></tr></thead>
                <tbody className="divide-y divide-white/10">
                  {[...instance.ledger].reverse().map((entry) => (
                    <tr key={entry.id}>
                      <td className="py-2">{localDateTime(entry.createdAt)}</td>
                      <td className="py-2 capitalize">{entry.entryType}{entry.reason ? ` · ${entry.reason}` : ""}{entry.externalReference ? ` · ${entry.externalReference}` : ""}</td>
                      <td className="py-2 text-right font-bold">{entry.sessionsDelta > 0 ? "+" : ""}{entry.sessionsDelta}</td>
                      <td className="py-2 text-white/55">{[
                        entry.linkedFhirProcedureId ? `Procedure/${entry.linkedFhirProcedureId}` : undefined,
                        entry.linkedFhirInvoiceId ? `Invoice/${entry.linkedFhirInvoiceId}` : undefined,
                      ].filter(Boolean).join(" · ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        ))}
        {packages.length === 0 && <p className="rounded border border-dashed border-white/10 p-8 text-center text-sm text-white/40">No packages have been sold to this patient.</p>}
      </div>
    </aside>
  );
}

function CreditBankHistory({ creditBank }: { creditBank: PatientCreditBank }) {
  return (
    <article className="rounded border border-emerald-300/20 bg-emerald-950/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-xs font-bold uppercase tracking-wide text-emerald-300/65">Stored value</p><h3 className="mt-1 text-lg font-semibold">Credit Bank</h3></div>
        <span className="rounded-full border border-emerald-300/30 bg-emerald-950/30 px-3 py-1 text-sm font-bold text-emerald-100">{money(creditBank.balanceCents)}</span>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[620px] text-left text-xs">
          <thead className="text-white/40"><tr><th className="pb-2">Date</th><th className="pb-2">Entry</th><th className="pb-2 text-right">Amount</th><th className="pb-2">Linked Invoice</th><th className="pb-2">Reason</th></tr></thead>
          <tbody className="divide-y divide-white/10">
            {[...creditBank.ledger].reverse().map((entry) => (
              <tr key={entry.id}>
                <td className="py-2">{localDateTime(entry.createdAt)}</td>
                <td className="py-2 capitalize">{entry.entryType.replace("_", " ")}</td>
                <td className={`py-2 text-right font-bold ${entry.amountCents >= 0 ? "text-emerald-200" : "text-white"}`}>{entry.amountCents > 0 ? "+" : ""}{money(entry.amountCents)}</td>
                <td className="py-2 text-white/55">{entry.linkedFhirInvoiceId ? `Invoice/${entry.linkedFhirInvoiceId}` : "—"}</td>
                <td className="py-2 text-white/55">{entry.reason ?? "—"}</td>
              </tr>
            ))}
            {creditBank.ledger.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-white/40">No Credit Bank activity.</td></tr>}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function PackageLifecycleAction({
  patientReference,
  packageInstance,
  onChanged,
}: {
  patientReference: string;
  packageInstance: PatientPackageInstance;
  onChanged: (packageInstance: PatientPackageInstance, creditBank?: PatientCreditBank) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const storeCredit = packageInstance.refundPolicy === "store_credit_only";

  async function submit() {
    if (!reason.trim() || (!storeCredit && !externalReference.trim())) {
      setError(storeCredit ? "A conversion reason is required." : "A reason and external refund reference are required.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = storeCredit
        ? await convertPackageToCreditBank({ patientReference, packageInstanceId: packageInstance.id, reason: reason.trim() })
        : await attestPackageCashRefund({
          patientReference,
          packageInstanceId: packageInstance.id,
          reason: reason.trim(),
          externalReference: externalReference.trim(),
        });
      onChanged(result.package, result.creditBank);
      setDone(storeCredit
        ? `${money(result.amountCents)} converted to Credit Bank.`
        : `${money(result.amountCents)} cash refund attested.`);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded border border-white/10 bg-black/20 p-3">
      {!open && !done && <button type="button" onClick={() => setOpen(true)} className="rounded border border-white/15 px-3 py-2 text-xs font-bold text-white/75">{storeCredit ? "Convert remainder to Credit Bank" : "Record attested cash refund"}</button>}
      {open && (
        <div className="grid gap-3">
          <p className="text-xs text-white/50">This permanently zeroes {packageInstance.remainingSessions} remaining session{packageInstance.remainingSessions === 1 ? "" : "s"}. The original package stays in history.</p>
          <input aria-label="Package adjustment reason" value={reason} onChange={(event) => setReason(event.target.value)} className="scheduler-input" placeholder="Required reason" />
          {!storeCredit && <input aria-label="External refund reference" value={externalReference} onChange={(event) => setExternalReference(event.target.value)} className="scheduler-input" placeholder="How cash left, e.g. check #1042" />}
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => void submit()} className="rounded bg-amber-700 px-3 py-2 text-xs font-bold disabled:opacity-40">{busy ? "Recording…" : "Confirm permanent adjustment"}</button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)} className="rounded border border-white/15 px-3 py-2 text-xs text-white/60">Cancel</button>
          </div>
        </div>
      )}
      {done && <p role="status" className="text-xs text-emerald-300">{done}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-200">{error}</p>}
    </div>
  );
}

function refundPolicyLabel(policy: PatientPackageInstance["refundPolicy"]): string {
  if (policy === "store_credit_only") return "Store credit only";
  if (policy === "prorated_cash") return "Prorated cash — manual attestation required";
  return "Non-refundable";
}

function localDate(value: string): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString();
}

function localDateTime(value: string): string {
  return new Date(value).toLocaleString();
}
