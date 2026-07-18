import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { Bundle, Invoice, Patient } from "@medplum/fhirtypes";
import type { ClaimsApiOptions } from "../../lib/claims-worklist";
import { fhir } from "../../lib/fhir";
import { dollarsToCents } from "../../lib/manual-eob";
import {
  applyPatientCredit,
  fetchPatientPayments,
  fetchUnappliedCredits,
  transferPatientCredit,
  voidPatientCredit,
  type PatientPaymentRow,
  type UnappliedCredit,
} from "../../lib/patient-payments";
import { patientName } from "../../lib/scheduler-appointment-ui";
import { PatientSearch } from "../PatientPicker";
import { downloadCsvExport, queryPath } from "../../lib/reporting";
import { CollectPanel } from "../../components/CollectPanel";
import { BalanceChips } from "../../components/commercial/BalanceChips";

type View = "all" | "unapplied";
type CreditAction =
  | { kind: "apply"; credit: UnappliedCredit }
  | { kind: "transfer"; credit: UnappliedCredit }
  | { kind: "void"; credit: UnappliedCredit };

export function PatientPayments() {
  const [patient, setPatient] = useState<Patient>();
  const [view, setView] = useState<View>("all");
  const [payments, setPayments] = useState<PatientPaymentRow[]>([]);
  const [credits, setCredits] = useState<UnappliedCredit[]>([]);
  const [openInvoices, setOpenInvoices] = useState<Invoice[]>([]);
  const [action, setAction] = useState<CreditAction>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dateFilters, setDateFilters] = useState<{ startDate?: string; endDate?: string }>({});
  const [appliedDateFilters, setAppliedDateFilters] = useState<{ startDate?: string; endDate?: string }>({});
  const [exporting, setExporting] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const api = patientPaymentApiOptions();

  const load = async (
    patientReference: string,
    dates: { startDate?: string; endDate?: string } = appliedDateFilters,
  ) => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextPayments, nextCredits, invoiceBundle] = await Promise.all([
        fetchPatientPayments({ patientReference, ...dates }, api),
        fetchUnappliedCredits(patientReference, api),
        fhir.search<Invoice>("Invoice", {
          subject: patientReference,
          status: "issued",
          _count: "100",
          _sort: "-date",
        }),
      ]);
      setPayments(nextPayments);
      setCredits(nextCredits);
      setOpenInvoices(bundleResources(invoiceBundle));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  };

  const selectPatient = (selected: Patient) => {
    if (!selected.id) return;
    setPatient(selected);
    setAction(undefined);
    setPayments([]);
    setCredits([]);
    setOpenInvoices([]);
    setDateFilters({});
    setAppliedDateFilters({});
    void load(`Patient/${selected.id}`, {});
  };

  const submitAction = async (input: CreditActionInput) => {
    setBusy(true);
    setError(undefined);
    try {
      if (input.kind === "apply") await applyPatientCredit(input.body, api);
      if (input.kind === "transfer") await transferPatientCredit(input.body, api);
      if (input.kind === "void") await voidPatientCredit(input.body, api);
      setAction(undefined);
      if (patient?.id) await load(`Patient/${patient.id}`, appliedDateFilters);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const paymentByReference = useMemo(
    () => new Map(payments.map((payment) => [payment.paymentReconciliationReference, payment])),
    [payments],
  );

  const filterPayments = (event: FormEvent) => {
    event.preventDefault();
    if (!patient?.id) return;
    const next = { ...dateFilters };
    setAppliedDateFilters(next);
    void load(`Patient/${patient.id}`, next);
  };

  const exportPayments = async () => {
    if (!patient?.id) return;
    setExporting(true);
    setError(undefined);
    try {
      await downloadCsvExport(
        queryPath("/payments/reconciliations/export", {
          patientReference: `Patient/${patient.id}`,
          ...appliedDateFilters,
        }),
        "patient-payments.csv",
        api,
      );
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setExporting(false);
    }
  };

  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Claims management</p>
          <h1 className="text-2xl font-semibold">Patient payments</h1>
          <p className="mt-1 text-sm text-white/50">Review collected payments and work unapplied patient credit.</p>
        </div>
        {patient && (
          <button type="button" onClick={() => { setPatient(undefined); setPayments([]); setCredits([]); setOpenInvoices([]); }} className="rounded border border-white/15 px-3 py-2 text-sm text-white/65">
            Change patient
          </button>
        )}
      </header>

      {error && <div role="alert" className="mb-4 rounded border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{error}</div>}

      {!patient ? (
        <section className="rounded-lg border border-white/10 bg-bg-panel/80 p-5">
          <h2 className="text-lg font-semibold">Select a patient</h2>
          <p className="mt-1 text-sm text-white/45">Choose a patient before loading the payment ledger.</p>
          <div className="mt-5"><PatientSearch actionLabel="View payments" onSelect={selectPatient} /></div>
        </section>
      ) : (
        <>
          <section className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-400/20 bg-blue-950/20 px-4 py-3">
            <div><strong>{patientName(patient)}</strong><span className="ml-2 text-xs text-white/45">Patient/{patient.id}</span>{patient.id && <BalanceChips patientReference={`Patient/${patient.id}`} />}</div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setCollecting(true)} className="rounded bg-blue-600 px-4 py-2 text-sm font-bold">Collect</button>
              <div className="flex rounded border border-white/10 bg-black/20 p-1">
                <Tab active={view === "all"} onClick={() => setView("all")}>All payments</Tab>
                <Tab active={view === "unapplied"} onClick={() => setView("unapplied")}>Unapplied credit ({credits.length})</Tab>
              </div>
            </div>
          </section>

          <form onSubmit={filterPayments} className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-bg-panel/80 p-4">
            <Field label="Payment date from" type="date" value={dateFilters.startDate ?? ""} onChange={(startDate) => setDateFilters({ ...dateFilters, startDate: startDate || undefined })} />
            <Field label="Payment date through" type="date" value={dateFilters.endDate ?? ""} onChange={(endDate) => setDateFilters({ ...dateFilters, endDate: endDate || undefined })} />
            <button type="submit" disabled={loading} className="h-10 rounded bg-blue-600 px-4 text-sm font-bold disabled:opacity-50">Apply dates</button>
            <button type="button" disabled={exporting || loading} onClick={() => void exportPayments()} className="h-10 rounded border border-blue-400/30 bg-blue-950/30 px-4 text-sm font-bold text-blue-200 disabled:opacity-50">
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
          </form>

          {loading ? (
            <div className="grid min-h-52 place-items-center text-sm text-white/50">Loading patient payments…</div>
          ) : view === "all" ? (
            <AllPaymentsTable payments={payments} />
          ) : (
            <UnappliedCreditsView
              credits={credits}
              paymentByReference={paymentByReference}
              openInvoices={openInvoices}
              onAction={setAction}
            />
          )}
        </>
      )}

      {action && (
        <CreditActionPanel
          key={`${action.kind}-${action.credit.paymentReconciliation.id}`}
          action={action}
          payment={paymentByReference.get(paymentReference(action.credit))}
          openInvoices={openInvoices}
          busy={busy}
          onClose={() => setAction(undefined)}
          onSubmit={(input) => void submitAction(input)}
        />
      )}
      {collecting && patient?.id && (
        <CollectPanel
          patientReference={`Patient/${patient.id}`}
          patientName={patientName(patient)}
          onClose={() => setCollecting(false)}
          onCollected={() => void load(`Patient/${patient.id}`, appliedDateFilters)}
        />
      )}
    </main>
  );
}

export function AllPaymentsTable({ payments }: { payments: readonly PatientPaymentRow[] }) {
  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-bg-panel/80">
      <div className="border-b border-white/10 px-4 py-3 text-sm text-white/50">{payments.length === 1 ? "1 payment" : `${payments.length} payments`}</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-black/20 text-xs uppercase tracking-wide text-white/40">
            <tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Tender</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3 text-right">Allocated</th><th className="px-4 py-3 text-right">Unapplied</th><th className="px-4 py-3">Linked invoices</th><th className="px-4 py-3">Status</th></tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {payments.map((payment) => (
              <tr key={payment.paymentReconciliationReference} className="text-white/70 hover:bg-white/5">
                <td className="px-4 py-3">{payment.date}</td>
                <td className="px-4 py-3 font-semibold text-blue-300">{payment.tender}</td>
                <td className="px-4 py-3 text-right">{money(payment.amountCents)}</td>
                <td className="px-4 py-3 text-right">{money(payment.allocatedCents)}</td>
                <td className="px-4 py-3 text-right">{money(payment.unappliedCents)}</td>
                <td className="px-4 py-3">{payment.invoices.length > 0 ? payment.invoices.map((invoice) => invoice.label).join(", ") : "—"}</td>
                <td className="px-4 py-3"><PaymentStatus status={payment.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {payments.length === 0 && <div className="px-4 py-12 text-center text-sm text-white/35">No patient payments found.</div>}
      </div>
    </section>
  );
}

export function UnappliedCreditsView({
  credits,
  paymentByReference,
  openInvoices,
  onAction,
}: {
  credits: readonly UnappliedCredit[];
  paymentByReference: ReadonlyMap<string, PatientPaymentRow>;
  openInvoices: readonly Invoice[];
  onAction: (action: CreditAction) => void;
}) {
  return (
    <section className="grid gap-3">
      {credits.map((credit) => {
        const reference = paymentReference(credit);
        const payment = paymentByReference.get(reference);
        const allocatedInvoices = payment?.invoices ?? [];
        const hasApplyTarget = openInvoices.some((invoice) => !allocatedInvoices.some((allocated) => allocated.reference === `Invoice/${invoice.id}`));
        const hasTransferTarget = allocatedInvoices.length > 0 && openInvoices.some((invoice) =>
          !allocatedInvoices.some((allocated) => allocated.reference === `Invoice/${invoice.id}`),
        );
        return (
          <article key={reference} className="rounded-lg border border-amber-300/20 bg-bg-panel/80 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-amber-200/60">Unapplied credit</p>
                <h2 className="mt-1 text-2xl font-semibold text-amber-100">{money(credit.unappliedCents)}</h2>
                <p className="mt-2 text-sm text-white/50">{payment?.tender ?? "Recorded payment"} · collected {payment?.date ?? credit.paymentReconciliation.paymentDate}</p>
                {allocatedInvoices.length > 0 && <p className="mt-1 text-xs text-white/35">Also allocated to {allocatedInvoices.map((invoice) => invoice.label).join(", ")}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <ActionButton disabled={!hasApplyTarget} onClick={() => onAction({ kind: "apply", credit })}>Apply</ActionButton>
                {allocatedInvoices.length > 0 && <ActionButton disabled={!hasTransferTarget} onClick={() => onAction({ kind: "transfer", credit })}>Transfer</ActionButton>}
                {payment?.canVoid && payment.method && <ActionButton tone="danger" onClick={() => onAction({ kind: "void", credit })}>Void</ActionButton>}
              </div>
            </div>
          </article>
        );
      })}
      {credits.length === 0 && <div className="rounded-lg border border-dashed border-white/10 bg-bg-panel/50 px-4 py-12 text-center text-sm text-white/35">No unapplied credit for this patient.</div>}
    </section>
  );
}

type CreditActionInput =
  | { kind: "apply"; body: { paymentReconciliationReference: string; invoiceReference: string; amountCents: number } }
  | { kind: "transfer"; body: { paymentReconciliationReference: string; fromInvoiceReference: string; toInvoiceReference: string; reason: string } }
  | { kind: "void"; body: { paymentReconciliationReference: string; method: "manual-cash" | "clover" } };

export function CreditActionPanel({
  action,
  payment,
  openInvoices,
  busy,
  onClose,
  onSubmit,
}: {
  action: CreditAction;
  payment?: PatientPaymentRow;
  openInvoices: readonly Invoice[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: CreditActionInput) => void;
}) {
  const reference = paymentReference(action.credit);
  const allocatedReferences = payment?.invoices.map((invoice) => invoice.reference) ?? [];
  const applyOptions = openInvoices.filter((invoice) => invoice.id && !allocatedReferences.includes(`Invoice/${invoice.id}`));
  const [amount, setAmount] = useState((action.credit.unappliedCents / 100).toFixed(2));
  const [fromInvoiceReference, setFromInvoiceReference] = useState(allocatedReferences[0] ?? "");
  const transferOptions = openInvoices.filter((invoice) => invoice.id && `Invoice/${invoice.id}` !== fromInvoiceReference && !allocatedReferences.includes(`Invoice/${invoice.id}`));
  const [toInvoiceReference, setToInvoiceReference] = useState(`Invoice/${(action.kind === "apply" ? applyOptions : transferOptions)[0]?.id ?? ""}`);
  const [reason, setReason] = useState("");

  const submit = () => {
    if (action.kind === "apply") {
      onSubmit({ kind: "apply", body: { paymentReconciliationReference: reference, invoiceReference: toInvoiceReference, amountCents: dollarsToCents(amount) } });
    }
    if (action.kind === "transfer") {
      onSubmit({ kind: "transfer", body: { paymentReconciliationReference: reference, fromInvoiceReference, toInvoiceReference, reason: reason.trim() } });
    }
    if (action.kind === "void" && payment?.method) {
      onSubmit({ kind: "void", body: { paymentReconciliationReference: reference, method: payment.method } });
    }
  };

  const valid = action.kind === "void"
    ? Boolean(payment?.method)
    : action.kind === "apply"
      ? Boolean(toInvoiceReference) && safeDollarsToCents(amount) > 0 && safeDollarsToCents(amount) <= action.credit.unappliedCents
      : Boolean(fromInvoiceReference && toInvoiceReference && reason.trim());

  return (
    <aside role="dialog" aria-label={`${actionLabel(action.kind)} patient credit`} className="fixed inset-y-0 right-12 z-40 flex w-[min(560px,calc(100vw-3rem))] flex-col border-l border-white/15 bg-[#0c0c18] shadow-2xl">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <div><p className="text-xs font-bold uppercase tracking-wide text-white/40">Unapplied credit</p><h2 className="font-bold text-white">{actionLabel(action.kind)} {money(action.credit.unappliedCents)}</h2></div>
        <button type="button" aria-label="Close panel" onClick={onClose} className="text-white/60 hover:text-white">✕</button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {action.kind === "apply" && <>
          <InvoiceSelect label="Open issued Invoice" value={toInvoiceReference} invoices={applyOptions} onChange={setToInvoiceReference} />
          <Field label="Amount to apply" type="number" value={amount} onChange={setAmount} />
          <p className="text-xs text-white/40">Partial allocation is allowed. Maximum {money(action.credit.unappliedCents)}.</p>
        </>}
        {action.kind === "transfer" && <>
          <label className="block text-xs font-bold text-white/55">From Invoice<select value={fromInvoiceReference} onChange={(event) => { setFromInvoiceReference(event.target.value); setToInvoiceReference(""); }} className="mt-1.5 h-10 w-full rounded border border-white/15 bg-black/30 px-3 text-sm text-white">{payment?.invoices.map((invoice) => <option key={invoice.reference} value={invoice.reference}>{invoice.label}</option>)}</select></label>
          <InvoiceSelect label="To open issued Invoice" value={toInvoiceReference} invoices={transferOptions} onChange={setToInvoiceReference} />
          <Field label="Transfer reason" value={reason} onChange={setReason} />
        </>}
        {action.kind === "void" && <div className="rounded border border-red-400/30 bg-red-950/30 p-4 text-sm text-red-100">Void this same-day unapplied payment? The processor/FHIR lifecycle guard will make the final determination.</div>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-white/10 p-4">
        <button type="button" onClick={onClose} className="rounded border border-white/15 px-4 py-2 text-white/65">Cancel</button>
        <button type="button" disabled={busy || !valid} onClick={submit} className={`rounded px-5 py-2 font-bold disabled:opacity-50 ${action.kind === "void" ? "bg-red-700" : "bg-blue-600"}`}>{busy ? "Working…" : actionLabel(action.kind)}</button>
      </footer>
    </aside>
  );
}

function InvoiceSelect({ label, value, invoices, onChange }: { label: string; value: string; invoices: readonly Invoice[]; onChange: (value: string) => void }) {
  return <label className="block text-xs font-bold text-white/55">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1.5 h-10 w-full rounded border border-white/15 bg-black/30 px-3 text-sm text-white"><option value="">Select Invoice</option>{invoices.map((invoice) => <option key={invoice.id} value={`Invoice/${invoice.id}`}>{invoiceLabel(invoice)}</option>)}</select></label>;
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: "text" | "number" | "date" }) {
  return <label className="block text-xs font-bold text-white/55">{label}<input type={type} min={type === "number" ? "0.01" : undefined} step={type === "number" ? "0.01" : undefined} value={value} onChange={(event) => onChange(event.target.value)} className="mt-1.5 h-10 w-full rounded border border-white/15 bg-black/30 px-3 text-sm text-white" /></label>;
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className={`rounded px-3 py-1.5 text-sm ${active ? "bg-blue-600 font-bold text-white" : "text-white/55"}`}>{children}</button>;
}

function ActionButton({ children, onClick, disabled = false, tone = "default" }: { children: string; onClick: () => void; disabled?: boolean; tone?: "default" | "danger" }) {
  return <button type="button" disabled={disabled} onClick={onClick} className={`rounded border px-3 py-2 text-sm font-bold disabled:opacity-35 ${tone === "danger" ? "border-red-400/30 bg-red-950/40 text-red-200" : "border-blue-400/30 bg-blue-950/30 text-blue-200"}`}>{children}</button>;
}

function PaymentStatus({ status }: { status: PatientPaymentRow["status"] }) {
  return <span className={`rounded-full px-2 py-1 text-xs font-bold ${status === "cancelled" ? "bg-red-950/70 text-red-200" : "bg-emerald-950/70 text-emerald-200"}`}>{status}</span>;
}

function invoiceLabel(invoice: Invoice): string {
  return invoice.identifier?.find((identifier) => identifier.value)?.value ?? `Invoice/${invoice.id}`;
}

function paymentReference(credit: UnappliedCredit): string {
  return `PaymentReconciliation/${credit.paymentReconciliation.id}`;
}

function actionLabel(action: CreditAction["kind"]): string {
  return action[0].toUpperCase() + action.slice(1);
}

function safeDollarsToCents(value: string): number {
  try { return dollarsToCents(value); } catch { return 0; }
}

function bundleResources(bundle: Bundle<Invoice>): Invoice[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function patientPaymentApiOptions(): ClaimsApiOptions {
  const meta = import.meta as ImportMeta & { env?: { VITE_ODOS_MCP_BASE_URL?: string } };
  return { authorization: fhir.authHeader(), baseUrl: meta.env?.VITE_ODOS_MCP_BASE_URL?.replace(/\/$/, "") ?? "" };
}
