import { useEffect, useMemo, useState } from "react";
import {
  centsFromMoneyInput,
  collectRecordedTender,
  fetchOpenCharges,
  moneyInputFromCents,
  type CollectTender,
  type CompletedCollection,
  type OpenChargeLine,
  type OpticalCollectionOrder,
} from "../lib/collect";
import { renderReceiptSheet, type FinancialSummary } from "../lib/optical-financial-summary";
import { fhir } from "../lib/fhir";
import { openPrintWindow } from "../lib/print-window";
import { BalanceChips } from "./commercial/BalanceChips";
import { CheckoutRedeem } from "./commercial/CheckoutRedeem";
import { SaleSheet } from "./commercial/SaleSheet";
import { loadStatementMessageConfigSingleton } from "../scenes/settings/StatementMessagesSettings";

const TENDERS: Array<{ code: CollectTender; label: string }> = [
  { code: "CASH", label: "Cash" },
  { code: "CHECK", label: "Check" },
  { code: "CARD_MANUAL", label: "Card — manual entry" },
];

export type CollectPanelResult = CompletedCollection;

export function CollectPanel({
  patientReference,
  patientName,
  onClose,
  initialCharges,
  opticalOrder,
  embedded = false,
  disabled = false,
  onCollected,
  onPackageBalanceChanged,
  loadCharges = fetchOpenCharges,
}: {
  patientReference: string;
  patientName?: string;
  onClose: () => void;
  initialCharges?: readonly OpenChargeLine[];
  opticalOrder?: OpticalCollectionOrder;
  embedded?: boolean;
  disabled?: boolean;
  onCollected?: (result: CollectPanelResult) => void;
  onPackageBalanceChanged?: () => void;
  loadCharges?: (patientReference: string) => Promise<OpenChargeLine[]>;
}) {
  const [charges, setCharges] = useState<OpenChargeLine[]>(initialCharges ? [...initialCharges] : []);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set((initialCharges ?? []).map((charge) => charge.id)),
  );
  const [tender, setTender] = useState<CollectTender>("CASH");
  const [amountInput, setAmountInput] = useState("0.00");
  const [loading, setLoading] = useState(!initialCharges);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<{ result: CollectPanelResult; lines: OpenChargeLine[] }>();
  const [sellingPackage, setSellingPackage] = useState(false);
  const [packageRevision, setPackageRevision] = useState(0);

  useEffect(() => {
    if (initialCharges) {
      const next = [...initialCharges];
      setCharges(next);
      setSelectedIds(new Set(next.map((charge) => charge.id)));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadCharges(patientReference)
      .then((next) => {
        if (cancelled) return;
        setCharges(next);
        setSelectedIds(new Set(next.map((charge) => charge.id)));
      })
      .catch((cause) => {
        if (!cancelled) setError(messageOf(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [initialCharges, loadCharges, patientReference]);

  const selectedCharges = useMemo(
    () => charges.filter((charge) => selectedIds.has(charge.id)),
    [charges, selectedIds],
  );
  const openBalanceCents = useMemo(
    () => charges.reduce((total, charge) => total + charge.amountCents, 0),
    [charges],
  );
  const collectingCents = useMemo(
    () => selectedCharges.reduce((total, charge) => total + charge.amountCents, 0),
    [selectedCharges],
  );

  useEffect(() => {
    setAmountInput(moneyInputFromCents(collectingCents));
  }, [collectingCents]);

  const collect = async () => {
    const amountCents = centsFromMoneyInput(amountInput);
    setError(undefined);
    if (!selectedCharges.length || amountCents === undefined || amountCents !== collectingCents) {
      setError(`Amount must equal the selected balance ${money(collectingCents)}.`);
      return;
    }
    setBusy(true);
    try {
      const request = {
        patientReference,
        selectedOpenChargeLineIds: selectedCharges.map((charge) => charge.id),
        amountCents,
        ...(opticalOrder ? { opticalOrder } : {}),
      };
      const result = await collectRecordedTender({ ...request, tender });
      setReceipt({ result, lines: selectedCharges });
      onCollected?.(result);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const content = receipt ? (
    <ReceiptView
      patientReference={patientReference}
      patientName={patientName}
      tender={tender}
      receipt={receipt}
      onClose={onClose}
    />
  ) : (
    <>
      <header className="flex items-start justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-white/40">Collect payment</p>
          <h2 className="text-lg font-semibold">{patientName || patientReference}</h2>
          <p className="text-sm text-white/50">Open balance {money(openBalanceCents)}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setSellingPackage(true)} className="rounded border border-cyan-300/25 bg-cyan-950/20 px-3 py-2 text-xs font-bold text-cyan-100">Add package</button>
          {!embedded && <button type="button" aria-label="Close collect panel" onClick={onClose} className="text-white/60 hover:text-white">✕</button>}
        </div>
      </header>
      <div className="space-y-4 p-4">
        <BalanceChips patientReference={patientReference} revision={packageRevision} />
        {loading ? <p className="text-sm text-white/50">Loading open charges…</p> : (
          <div className="flex flex-wrap gap-2" aria-label="Open charges">
            {charges.map((charge) => {
              const selected = selectedIds.has(charge.id);
              return (
                <div key={charge.id} className="min-w-[240px] flex-1">
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedIds((current) => {
                      const next = new Set(current);
                      if (selected) next.delete(charge.id); else next.add(charge.id);
                      return next;
                    })}
                    className={`w-full rounded-full border px-3 py-2 text-left text-xs ${selected ? "border-blue-400 bg-blue-950/60 text-blue-100" : "border-white/15 text-white/55"}`}
                  >
                    <span className="block font-bold">{charge.description} · {money(charge.amountCents)}</span>
                    <span className="text-[11px] opacity-60">{charge.source === "optical" ? "Optical" : "Other"}{charge.date ? ` · ${charge.date}` : ""}</span>
                  </button>
                  <CheckoutRedeem
                    patientReference={patientReference}
                    chargeItemReference={`ChargeItem/${charge.id}`}
                    procedureReference={charge.procedureReference}
                    procedureCode={charge.code}
                    revision={packageRevision}
                    onRedeemed={() => {
                      setCharges((current) => current.filter((item) => item.id !== charge.id));
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        next.delete(charge.id);
                        return next;
                      });
                      setPackageRevision((current) => current + 1);
                      onPackageBalanceChanged?.();
                    }}
                  />
                </div>
              );
            })}
            {!charges.length && <p className="text-sm text-white/40">No open charges.</p>}
          </div>
        )}
        <div className="rounded border border-white/10 bg-black/20 p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-white/40">Collecting</p>
          <p className="mt-1 text-2xl font-semibold">{money(collectingCents)}</p>
        </div>
        <fieldset>
          <legend className="mb-2 text-xs font-bold uppercase tracking-wide text-white/40">Tender</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {TENDERS.map((entry) => (
              <button
                key={entry.code}
                type="button"
                aria-pressed={tender === entry.code}
                onClick={() => setTender(entry.code)}
                className={`rounded border px-3 py-2 text-sm ${tender === entry.code ? "border-blue-400 bg-blue-600 font-bold" : "border-white/15 text-white/60"}`}
              >{entry.label}</button>
            ))}
          </div>
        </fieldset>
        <label className="block text-xs font-bold text-white/55">
          Amount
          <input
            aria-label="Collection amount"
            inputMode="decimal"
            disabled={!selectedCharges.length}
            value={amountInput}
            onChange={(event) => setAmountInput(event.target.value)}
            className="mt-1.5 h-10 w-full rounded border border-white/15 bg-black/30 px-3 text-sm text-white disabled:opacity-40"
          />
        </label>
        {error && <div role="alert" className="rounded border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-white/10 p-4">
        {!embedded && <button type="button" onClick={onClose} className="rounded border border-white/15 px-4 py-2 text-white/65">Cancel</button>}
        <button type="button" disabled={disabled || busy || !selectedCharges.length} onClick={() => void collect()} className="rounded bg-blue-600 px-5 py-2 font-bold disabled:opacity-40">
          {busy ? "Collecting…" : "Collect"}
        </button>
      </footer>
      {sellingPackage && (
        <SaleSheet
          patientReference={patientReference}
          patientName={patientName}
          onClose={() => setSellingPackage(false)}
          onSold={() => {
            setPackageRevision((current) => current + 1);
            onPackageBalanceChanged?.();
          }}
        />
      )}
    </>
  );

  return embedded ? (
    <section aria-label="Collect payment" className="rounded border border-white/10">{content}</section>
  ) : (
    <aside role="dialog" aria-label="Collect payment" className="fixed inset-y-0 right-0 z-50 flex w-[min(620px,100vw)] flex-col overflow-y-auto border-l border-white/15 bg-[#0c0c18] shadow-2xl">
      {content}
    </aside>
  );
}

function ReceiptView({
  patientReference,
  patientName,
  tender,
  receipt,
  onClose,
}: {
  patientReference: string;
  patientName?: string;
  tender: CollectTender;
  receipt: { result: CollectPanelResult; lines: OpenChargeLine[] };
  onClose: () => void;
}) {
  const [footer, setFooter] = useState<{ ready: boolean; message?: string }>({ ready: false });
  useEffect(() => {
    let cancelled = false;
    loadStatementMessageConfigSingleton(fhir)
      .then(({ config }) => {
        if (!cancelled) setFooter({ ready: true, message: config.receiptFooterMessage });
      })
      .catch((error: unknown) => {
        console.error("Receipt footer message read skipped.", error);
        if (!cancelled) setFooter({ ready: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const print = () => {
    try {
      printReceipt({ patientReference, patientName, tender, receipt, receiptFooterMessage: footer.message });
    } catch (error) {
      console.error("Receipt printing failed.", error);
    }
  };
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-white/10 px-4 py-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-300/70">Payment collected</p>
        <h2 className="mt-1 text-xl font-semibold">{money(receipt.result.amountChargedCents)}</h2>
        <p className="text-sm text-white/50">{tenderLabel(tender)} · Invoice/{receipt.result.invoiceId}</p>
      </header>
      <div className="flex-1 space-y-2 p-4">
        {receipt.lines.map((line) => <div key={line.id} className="flex justify-between border-b border-white/10 py-2 text-sm"><span>{line.description}</span><span>{money(line.amountCents)}</span></div>)}
      </div>
      <footer className="flex justify-end gap-2 border-t border-white/10 p-4">
        <button type="button" disabled={!footer.ready} onClick={print} className="rounded border border-white/15 px-4 py-2 disabled:opacity-40">Print receipt</button>
        <button type="button" onClick={onClose} className="rounded bg-blue-600 px-5 py-2 font-bold">Done</button>
      </footer>
    </div>
  );
}

export function printReceipt(
  input: {
    patientReference: string;
    patientName?: string;
    tender: CollectTender;
    receipt: { result: CollectPanelResult; lines: OpenChargeLine[] };
    receiptFooterMessage?: string;
  },
  deps: {
    openPrint?: typeof openPrintWindow;
  } = {},
): void {
  const summary = receiptSummary(
    input.patientReference,
    input.patientName,
    input.tender,
    input.receipt,
  );
  const printable = input.receiptFooterMessage
    ? { ...summary, receiptFooterMessage: input.receiptFooterMessage }
    : summary;
  const opened = (deps.openPrint ?? openPrintWindow)(
    `Receipt ${summary.header.orderId}`,
    renderReceiptSheet(printable),
  );
  if (!opened) throw new Error("The browser blocked the receipt print window.");
}

function receiptSummary(
  patientReference: string,
  patientName: string | undefined,
  tender: CollectTender,
  receipt: { result: CollectPanelResult; lines: OpenChargeLine[] },
): FinancialSummary {
  const lines = receipt.lines.map((line) => ({
    description: line.description,
    ...(line.code ? { code: line.code } : {}),
    quantity: line.quantity ?? 1,
    feeCents: line.feeCents ?? line.amountCents,
    ...(line.discount ? { discount: line.discount } : {}),
    taxCents: line.taxCents ?? 0,
    patientBalanceCents: line.amountCents,
  }));
  const chargesSubtotalCents = lines.reduce((sum, line) => sum + line.feeCents, 0);
  const discountTotalCents = lines.reduce((sum, line) => sum + (line.discount?.amountCents ?? 0), 0);
  const taxTotalCents = lines.reduce((sum, line) => sum + line.taxCents, 0);
  const total = lines.reduce((sum, line) => sum + line.patientBalanceCents, 0);
  return {
    header: {
      practiceName: "Integrated Vision & Aesthetics",
      patientName: patientName || patientReference,
      patientRef: patientReference,
      receiptDate: new Date().toISOString().slice(0, 10),
      orderId: receipt.result.deviceRequestId || receipt.result.invoiceId,
      invoiceId: receipt.result.invoiceId,
    },
    lines,
    totals: {
      chargesSubtotalCents,
      discountTotalCents,
      taxTotalCents,
      chargesPlusTaxCents: chargesSubtotalCents + taxTotalCents,
      netCents: total,
    },
    payments: { tenderLines: [{ tender: tenderLabel(tender), amountCents: total }], paymentsAppliedCents: total },
    amountDueNowCents: 0,
  };
}

function money(cents: number): string {
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function tenderLabel(tender: CollectTender): string {
  return TENDERS.find((entry) => entry.code === tender)?.label ?? tender;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
