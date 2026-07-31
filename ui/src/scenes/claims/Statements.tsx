import { useEffect, useRef, useState, type ComponentType } from "react";
import type { Patient } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import {
  accountCredit,
  fetchStatements,
  formatStatementMoney,
  generatePatientStatement,
  renderBalanceForwardStatement,
  runStatements,
  type StatementRow,
  type StatementRunResult,
} from "../../lib/statements";
import { PatientSearch } from "../PatientPicker";
import { recordDocumentPrintRequested } from "../../lib/audit-log";

export interface StatementsServices {
  list(): Promise<StatementRow[]>;
  generate(patientReference: string): Promise<StatementRunResult>;
  run(): Promise<StatementRunResult>;
  recordPrintRequested(statement: StatementRow): Promise<void>;
  print(statement: StatementRow): void;
}

export function Statements({
  services: injectedServices,
  PatientSearchComponent = PatientSearch,
}: {
  services?: StatementsServices;
  PatientSearchComponent?: ComponentType<{ onSelect: (patient: Patient) => void; actionLabel?: string }>;
} = {}) {
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string>();
  const [lastRun, setLastRun] = useState<StatementRunResult>();
  const api = { authorization: fhir.authHeader() };
  const services = injectedServices ?? {
    list: () => fetchStatements(api),
    generate: (patientReference: string) => generatePatientStatement(patientReference, api),
    run: () => runStatements(api),
    recordPrintRequested: (statement: StatementRow) => recordDocumentPrintRequested({
      documentKind: "statement",
      documentReference: statement.statementReference,
      patientReference: statement.patientReference,
    }, api),
    print: printStatement,
  };

  const reload = async () => {
    setLoading(true);
    setError(undefined);
    try { setStatements(await services.list()); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  };

  useEffect(() => { void reload(); }, []);

  const generateOne = async (patient: Patient) => {
    if (!patient.id) return;
    await execute(() => services.generate(`Patient/${patient.id}`));
  };

  const runBatch = async () => execute(() => services.run());

  const execute = async (operation: () => Promise<StatementRunResult>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await operation();
      setLastRun(result);
      await reload();
    } catch (cause) { setError(messageOf(cause)); }
    finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const printOne = (statement: StatementRow) => {
    setError(undefined);
    void services.recordPrintRequested(statement).catch((cause) => {
      console.error("ODOS statement print audit failed:", cause);
    });
    try { services.print(statement); }
    catch (cause) { setError(messageOf(cause)); }
  };

  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">The Desk</p><h1 className="text-2xl font-semibold">Statements</h1><p className="mt-1 text-sm text-white/50">Generate reconciled balance-forward statements for print. No mail or email transport is connected.</p></div>
        <button type="button" disabled={busy} onClick={() => void runBatch()} className="rounded bg-blue-600 px-4 py-2.5 text-sm font-bold disabled:opacity-50">{busy ? "Running…" : "Run statements"}</button>
      </header>
      {error && <div role="alert" className="mb-4 rounded border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{error}</div>}
      {lastRun && <RunNotice run={lastRun} />}
      <section className="mb-5 rounded-lg border border-white/10 bg-bg-panel/80 p-5">
        <h2 className="font-semibold">Generate one patient</h2><p className="mb-4 mt-1 text-sm text-white/45">Choose a patient to reconcile every issued Invoice and recorded payment allocation into one statement.</p>
        <PatientSearchComponent actionLabel={busy ? "Running…" : "Generate statement"} onSelect={(patient) => {
          if (!busyRef.current) void generateOne(patient);
        }} />
      </section>
      {loading ? <div className="grid min-h-52 place-items-center text-sm text-white/50">Loading statements…</div> : <StatementsContent statements={statements} onPrint={printOne} />}
    </main>
  );
}

export function StatementsContent({ statements, onPrint }: { statements: readonly StatementRow[]; onPrint: (statement: StatementRow) => void }) {
  return <section className="overflow-hidden rounded-lg border border-white/10 bg-bg-panel/80">
    <div className="border-b border-white/10 px-4 py-3 text-sm text-white/50">{statements.length === 1 ? "1 generated statement" : `${statements.length} generated statements`} · newest first</div>
    {statements.length === 0 ? <div className="px-5 py-14 text-center"><p className="font-semibold text-white/65">No statements generated yet.</p><p className="mt-1 text-sm text-white/35">Generate one patient or run the batch. No balance is shown until reconciliation succeeds.</p></div> : <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm"><thead className="bg-black/20 text-xs uppercase tracking-wide text-white/40"><tr><th className="px-4 py-3">Generated</th><th className="px-4 py-3">Patient</th><th className="px-4 py-3">Invoices</th><th className="px-4 py-3 text-right">Charges</th><th className="px-4 py-3 text-right">Payments</th><th className="px-4 py-3 text-right">Balance due</th><th className="px-4 py-3" /></tr></thead><tbody className="divide-y divide-white/10">{statements.map((statement) => {
      const credit = accountCredit(statement);
      return <tr key={statement.statementReference} className="text-white/70"><td className="px-4 py-3">{dateTime(statement.generatedAt)}</td><td className="px-4 py-3"><strong className="text-white">{statement.patientName}</strong><div className="text-xs text-white/35">{statement.patientReference}</div></td><td className="px-4 py-3">{statement.invoices.length}</td><td className="px-4 py-3 text-right">{formatStatementMoney(statement.totalNetCents)}</td><td className="px-4 py-3 text-right">{formatStatementMoney(statement.paymentsAppliedCents)}</td><td className="px-4 py-3 text-right"><strong className="text-blue-200">{formatStatementMoney(credit.balanceDueCents)}</strong>{credit.unappliedCreditCents > 0 && <div className="text-xs font-normal text-amber-200/70">Unapplied credit −{formatStatementMoney(credit.unappliedCreditCents)}</div>}{credit.creditBalanceCents > 0 && <div className="text-xs font-normal text-emerald-200/80">Credit balance {formatStatementMoney(credit.creditBalanceCents)}</div>}</td><td className="px-4 py-3 text-right"><button type="button" onClick={() => onPrint(statement)} className="rounded border border-blue-400/30 bg-blue-950/30 px-3 py-2 text-xs font-bold text-blue-200">Print</button></td></tr>;
    })}</tbody></table></div>}
  </section>;
}

function RunNotice({ run }: { run: StatementRunResult }) {
  return <section className={`mb-4 rounded border px-4 py-3 text-sm ${run.invalidRejects ? "border-amber-300/30 bg-amber-950/25 text-amber-100" : "border-emerald-300/25 bg-emerald-950/20 text-emerald-100"}`}>
    <strong>{run.generatedCount} generated</strong> · {run.skippedZeroBalanceCount} zero-balance skipped · {run.invalidRejects} invalid rejected
    {run.rejects.map((reject) => <div key={reject.patientReference} className="mt-2 text-xs"><strong>{reject.patientName}:</strong> {reject.reason}</div>)}
  </section>;
}

function printStatement(statement: StatementRow): void {
  const popup = window.open("", "_blank");
  if (!popup) throw new Error("The printable statement window was blocked.");
  popup.opener = null;
  popup.document.write(renderBalanceForwardStatement(statement));
  popup.document.close();
  popup.focus();
  popup.print();
}

function dateTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
