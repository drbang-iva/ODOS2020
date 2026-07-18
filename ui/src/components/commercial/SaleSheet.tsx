import { useEffect, useMemo, useState } from "react";
import {
  fetchPackageDefinitions,
  PackageFinalizationError,
  readPendingPackageSale,
  sellPackage,
  type PackageDefinition,
  type PackageSaleTender,
  type PatientPackageInstance,
} from "../../lib/commercial-engine";

const TENDERS: Array<{ code: PackageSaleTender; label: string }> = [
  { code: "CASH", label: "Cash" },
  { code: "CHECK", label: "Check" },
  { code: "CARD_MANUAL", label: "Card — manual entry" },
];

export function SaleSheet({
  patientReference,
  patientName,
  onClose,
  onSold,
}: {
  patientReference: string;
  patientName?: string;
  onClose: () => void;
  onSold?: (packageInstance: PatientPackageInstance) => void;
}) {
  const [pending] = useState(() => readPendingPackageSale(patientReference));
  const [definitions, setDefinitions] = useState<PackageDefinition[]>(() => pending ? [pending.definition] : []);
  const [definitionId, setDefinitionId] = useState(pending?.definition.id ?? "");
  const [tender, setTender] = useState<PackageSaleTender>(pending?.tender ?? "CASH");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [paidInvoiceReference, setPaidInvoiceReference] = useState<string | undefined>(pending?.invoiceReference);
  const selected = useMemo(() => definitions.find((definition) => definition.id === definitionId), [definitionId, definitions]);

  useEffect(() => {
    let cancelled = false;
    fetchPackageDefinitions()
      .then((items) => {
        if (cancelled) return;
        const active = items.filter((item) => item.active);
        setDefinitions(pending && !active.some((item) => item.id === pending.definition.id)
          ? [pending.definition, ...active]
          : active);
        if (!pending) setDefinitionId(active[0]?.id ?? "");
      })
      .catch((cause) => !cancelled && setError(messageOf(cause)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [pending]);

  async function sell() {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const packageInstance = await sellPackage({
        patientReference,
        definition: selected,
        tender,
        ...(paidInvoiceReference ? { paidInvoiceReference } : {}),
      });
      onSold?.(packageInstance);
      onClose();
    } catch (cause) {
      if (cause instanceof PackageFinalizationError) setPaidInvoiceReference(cause.invoiceReference);
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside role="dialog" aria-modal="true" aria-label="Sell care package" className="fixed inset-y-0 right-0 z-[70] flex w-[min(560px,100vw)] flex-col overflow-y-auto border-l border-white/15 bg-[#0c0c18] text-white shadow-2xl">
      <header className="flex items-start justify-between border-b border-white/10 px-5 py-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-300/70">Prepaid care</p>
          <h2 className="mt-1 text-xl font-semibold">Sell package</h2>
          <p className="text-sm text-white/50">{patientName ?? patientReference}</p>
        </div>
        <button type="button" aria-label="Close package sale" onClick={onClose}>✕</button>
      </header>
      <div className="grid flex-1 gap-5 p-5">
        {loading ? <p className="text-sm text-white/50">Loading package definitions…</p> : (
          <label className="grid gap-2 text-sm font-semibold text-white/70">
            Package
            <select disabled={Boolean(paidInvoiceReference)} className="scheduler-input" value={definitionId} onChange={(event) => setDefinitionId(event.target.value)}>
              {definitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
            </select>
          </label>
        )}
        {selected && (
          <section className="rounded border border-blue-400/25 bg-blue-950/25 p-4">
            <strong className="text-lg">{selected.name}</strong>
            <div className="mt-2 grid grid-cols-3 gap-3 text-sm text-white/60">
              <span><b className="block text-white">{selected.sessionCount}</b>sessions</span>
              <span><b className="block text-white">{money(selected.priceCents)}</b>package price</span>
              <span><b className="block text-white">{selected.expiryDays}</b>days to use</span>
            </div>
          </section>
        )}
        <fieldset>
          <legend className="mb-2 text-xs font-bold uppercase tracking-wide text-white/40">Payment collected as</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {TENDERS.map((entry) => (
              <button key={entry.code} type="button" disabled={Boolean(paidInvoiceReference)} aria-pressed={tender === entry.code} onClick={() => setTender(entry.code)} className={`rounded border px-3 py-2 text-sm disabled:opacity-40 ${tender === entry.code ? "border-blue-400 bg-blue-600 font-bold" : "border-white/15 text-white/60"}`}>
                {entry.label}
              </button>
            ))}
          </div>
        </fieldset>
        <p className="text-xs leading-relaxed text-white/45">The sale funds the package balance. Service production is recognized only when a session is redeemed at checkout.</p>
        {error && <div role="alert" className="rounded border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-white/10 p-4">
        <button type="button" onClick={onClose} className="rounded border border-white/15 px-4 py-2 text-white/65">Cancel</button>
        <button type="button" disabled={busy || !selected} onClick={() => void sell()} className="rounded bg-blue-600 px-5 py-2 font-bold disabled:opacity-40">{busy ? (paidInvoiceReference ? "Activating…" : "Collecting…") : paidInvoiceReference ? "Retry package activation" : selected ? `Collect ${money(selected.priceCents)}` : "No active packages"}</button>
      </footer>
    </aside>
  );
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
