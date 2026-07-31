import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { Claim, Patient } from "@medplum/fhirtypes";
import { fetchClaimSearch, type ClaimSearchRow } from "../../lib/claim-search";
import type { ClaimsApiOptions } from "../../lib/claims-worklist";
import { fhir } from "../../lib/fhir";
import {
  closeManualEob,
  createManualEob,
  dollarsToCents,
  fetchManualEobs,
  postManualEobClaim,
  type ManualEobHeader,
  type ManualEobLineInput,
} from "../../lib/manual-eob";
import { patientName } from "../../lib/scheduler-appointment-ui";
import { PatientSearch } from "../PatientPicker";

interface HeaderDraft {
  payerReference: string;
  paymentReference: string;
  paymentDate: string;
  depositDate: string;
  totalAmount: string;
}

interface LineDraft {
  itemSequence: number;
  allowed: string;
  paid: string;
  deductible: string;
  coinsurance: string;
  copay: string;
}

export function CarrierPayments() {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [headers, setHeaders] = useState<ManualEobHeader[]>([]);
  const [active, setActive] = useState<ManualEobHeader>();
  const [draft, setDraft] = useState<HeaderDraft>({
    payerReference: "",
    paymentReference: "",
    paymentDate: today,
    depositDate: today,
    totalAmount: "",
  });
  const [patient, setPatient] = useState<Patient>();
  const [claims, setClaims] = useState<ClaimSearchRow[]>([]);
  const [claim, setClaim] = useState<Claim>();
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const api = claimsApiOptions();

  const loadHeaders = useCallback(async () => {
    setLoading(true);
    try {
      setHeaders(await fetchManualEobs(api));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [api.authorization, api.baseUrl]);

  useEffect(() => {
    void loadHeaders();
  }, [loadHeaders]);

  const createHeader = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const header = await createManualEob({
        payerReference: draft.payerReference.trim(),
        paymentReference: draft.paymentReference.trim(),
        paymentDate: draft.paymentDate,
        depositDate: draft.depositDate,
        totalAmountCents: dollarsToCents(draft.totalAmount),
      }, api);
      setActive(header);
      setHeaders((current) => [header, ...current]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectPatient = async (selected: Patient) => {
    if (!selected.id) return;
    setPatient(selected);
    setClaim(undefined);
    setLines([]);
    setBusy(true);
    setError(undefined);
    try {
      setClaims(await fetchClaimSearch({ patient: `Patient/${selected.id}` }, api));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectClaim = async (row: ClaimSearchRow) => {
    setBusy(true);
    setError(undefined);
    try {
      const selected = await fhir.read<Claim>("Claim", row.claimReference.slice("Claim/".length));
      setClaim(selected);
      setLines((selected.item ?? []).map((item) => ({
        itemSequence: item.sequence,
        allowed: "0.00",
        paid: "0.00",
        deductible: "0.00",
        coinsurance: "0.00",
        copay: "0.00",
      })));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const postClaim = async () => {
    if (!active || !claim?.id) return;
    setBusy(true);
    setError(undefined);
    try {
      const header = await postManualEobClaim(active.id, {
        claimReference: `Claim/${claim.id}`,
        lines: lines.map(lineInput),
      }, api);
      setActive(header);
      setHeaders((current) => current.map((entry) => entry.id === header.id ? header : entry));
      setClaim(undefined);
      setLines([]);
      setPatient(undefined);
      setClaims([]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const closeHeader = async () => {
    if (!active) return;
    setBusy(true);
    setError(undefined);
    try {
      const header = await closeManualEob(active.id, api);
      setHeaders((current) => current.map((entry) => entry.id === header.id ? header : entry));
      setActive(undefined);
      setPatient(undefined);
      setClaims([]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Claims management</p>
          <h1 className="text-2xl font-semibold">Carrier payments</h1>
          <p className="mt-1 text-sm text-white/50">Post paper EOB and manual payer remittance lines.</p>
        </div>
        {active && (
          <button type="button" onClick={() => setActive(undefined)} className="rounded border border-white/15 px-3 py-2 text-sm text-white/65">
            Back to EOBs
          </button>
        )}
      </header>

      {error && <div role="alert" className="mb-4 rounded border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{error}</div>}

      {!active ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
          <ManualEobHeaderForm draft={draft} busy={busy} onChange={setDraft} onSubmit={createHeader} />
          <ManualEobList headers={headers} loading={loading} onSelect={setActive} />
        </div>
      ) : (
        <div className="space-y-5">
          <ManualEobSummary header={active} busy={busy} onClose={() => void closeHeader()} />
          <section className="rounded-lg border border-white/10 bg-bg-panel/80 p-4">
            <h2 className="font-semibold">Select patient, then claim</h2>
            <p className="mt-1 text-sm text-white/45">Claims already posted on this EOB are hidden from the list.</p>
            <div className="mt-4">
              {!patient ? (
                <PatientSearch actionLabel="Find claims" onSelect={(selected) => void selectPatient(selected)} />
              ) : (
                <div className="flex items-center justify-between rounded border border-blue-400/30 bg-blue-950/20 p-3">
                  <span><strong>{patientName(patient)}</strong><span className="ml-2 text-xs text-white/45">Patient/{patient.id}</span></span>
                  <button type="button" onClick={() => { setPatient(undefined); setClaims([]); }} className="text-sm text-blue-300">Change</button>
                </div>
              )}
            </div>
            {patient && (
              <ClaimChoices
                claims={claims.filter((row) =>
                  row.payerReference === active.payerReference
                  && !active.postings.some((posting) => posting.claimReference === row.claimReference),
                )}
                busy={busy}
                onSelect={(row) => void selectClaim(row)}
              />
            )}
          </section>
        </div>
      )}

      {active && claim && (
        <ManualEobPostingPanel
          claim={claim}
          lines={lines}
          busy={busy}
          onChange={setLines}
          onClose={() => setClaim(undefined)}
          onPost={() => void postClaim()}
        />
      )}
    </main>
  );
}

export function ManualEobHeaderForm({
  draft,
  busy,
  onChange,
  onSubmit,
}: {
  draft: HeaderDraft;
  busy: boolean;
  onChange: (draft: HeaderDraft) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const set = (key: keyof HeaderDraft, value: string) => onChange({ ...draft, [key]: value });
  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-white/10 bg-bg-panel/80 p-5">
      <h2 className="text-lg font-semibold">New EOB header</h2>
      <p className="mt-1 text-sm text-white/45">The header remains a draft until you explicitly close it.</p>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Field label="Payer Organization reference" value={draft.payerReference} placeholder="Organization/123" onChange={(value) => set("payerReference", value)} />
        <Field label="Check / EFT reference #" value={draft.paymentReference} onChange={(value) => set("paymentReference", value)} />
        <Field label="Payment date" type="date" value={draft.paymentDate} onChange={(value) => set("paymentDate", value)} />
        <Field label="Deposit date" type="date" value={draft.depositDate} onChange={(value) => set("depositDate", value)} />
        <Field label="Total amount" type="number" value={draft.totalAmount} placeholder="0.00" onChange={(value) => set("totalAmount", value)} />
      </div>
      <div className="mt-5 flex justify-end">
        <button type="submit" disabled={busy} className="rounded bg-blue-600 px-5 py-2 font-bold disabled:opacity-50">Start EOB</button>
      </div>
    </form>
  );
}

export function ManualEobSummary({ header, busy, onClose }: { header: ManualEobHeader; busy: boolean; onClose: () => void }) {
  const appliedPercent = Math.min(100, Math.round((header.appliedAmountCents / header.totalAmountCents) * 100));
  return (
    <section className="rounded-lg border border-white/10 bg-bg-panel/80 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-white/40">Draft EOB · {header.paymentReference}</p>
          <h2 className="mt-1 text-xl font-semibold">Applied {money(header.appliedAmountCents)} / Remaining {money(header.remainingAmountCents)}</h2>
          <p className="mt-2 text-sm text-white/45">{header.payerReference} · paid {header.paymentDate} · deposited {header.depositDate}</p>
        </div>
        <button type="button" disabled={busy} onClick={onClose} className="rounded border border-amber-300/30 bg-amber-950/30 px-4 py-2 text-sm font-bold text-amber-200 disabled:opacity-50">Close EOB</button>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-emerald-500" style={{ width: `${appliedPercent}%` }} /></div>
      {header.postings.length > 0 && (
        <div className="mt-4 grid gap-2 md:grid-cols-2">
          {header.postings.map((posting) => (
            <div key={posting.claimResponseReference} className="rounded border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/55">
              <span className="font-semibold text-white/75">{posting.claimReference}</span><span className="float-right">{money(posting.amountCents)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ManualEobList({ headers, loading, onSelect }: { headers: readonly ManualEobHeader[]; loading: boolean; onSelect: (header: ManualEobHeader) => void }) {
  const drafts = headers.filter((header) => header.status === "draft");
  return (
    <section className="rounded-lg border border-white/10 bg-bg-panel/80 p-5">
      <h2 className="text-lg font-semibold">Open drafts</h2>
      {loading ? <p className="mt-4 text-sm text-white/45">Loading EOBs…</p> : (
        <div className="mt-4 space-y-2">
          {drafts.map((header) => (
            <button key={header.id} type="button" onClick={() => onSelect(header)} className="w-full rounded border border-white/10 bg-black/20 p-3 text-left hover:bg-white/5">
              <div className="flex justify-between gap-3 text-sm"><strong>{header.paymentReference}</strong><span>{money(header.remainingAmountCents)} remaining</span></div>
              <div className="mt-1 text-xs text-white/40">{header.payerReference} · {header.paymentDate}</div>
            </button>
          ))}
          {drafts.length === 0 && <p className="rounded border border-dashed border-white/10 p-6 text-center text-sm text-white/35">No open EOB drafts</p>}
        </div>
      )}
    </section>
  );
}

function ClaimChoices({ claims, busy, onSelect }: { claims: readonly ClaimSearchRow[]; busy: boolean; onSelect: (row: ClaimSearchRow) => void }) {
  return (
    <div className="mt-4 overflow-hidden rounded border border-white/10">
      {claims.map((row) => (
        <button key={row.claimReference} type="button" disabled={busy} onClick={() => onSelect(row)} className="grid w-full grid-cols-[1fr_auto] gap-3 border-b border-white/10 px-4 py-3 text-left last:border-b-0 hover:bg-white/5 disabled:opacity-50">
          <span><strong className="text-blue-300">{row.claimNumber}</strong><span className="ml-3 text-sm text-white/50">{row.cptCodes.join(", ")}</span></span>
          <span className="text-sm text-white/60">{money(row.totalChargedCents)}</span>
        </button>
      ))}
      {!busy && claims.length === 0 && <div className="px-4 py-8 text-center text-sm text-white/35">No unposted claims match this EOB payer.</div>}
    </div>
  );
}

export function ManualEobPostingPanel({
  claim,
  lines,
  busy,
  onChange,
  onClose,
  onPost,
}: {
  claim: Claim;
  lines: LineDraft[];
  busy: boolean;
  onChange: (lines: LineDraft[]) => void;
  onClose: () => void;
  onPost: () => void;
}) {
  const update = (index: number, key: keyof Omit<LineDraft, "itemSequence">, value: string) => {
    onChange(lines.map((line, lineIndex) => lineIndex === index ? { ...line, [key]: value } : line));
  };
  return (
    <aside role="dialog" aria-label={`Post ${claim.id}`} className="fixed inset-y-0 right-12 z-40 flex w-[min(980px,calc(100vw-3rem))] flex-col border-l border-white/15 bg-[#0c0c18] shadow-2xl">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div><p className="text-xs font-bold uppercase tracking-wide text-white/40">Manual EOB posting</p><h2 className="font-bold text-white">Claim/{claim.id}</h2></div>
        <button type="button" aria-label="Close panel" onClick={onClose} className="text-white/60 hover:text-white">✕</button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-3">
          {(claim.item ?? []).map((item, index) => {
            const line = lines[index];
            if (!line) return null;
            const code = item.productOrService.coding?.[0]?.code ?? `Line ${item.sequence}`;
            return (
              <section key={item.sequence} className="rounded border border-white/10 bg-white/5 p-4">
                <div className="mb-3 flex justify-between"><strong>{code}</strong><span className="text-sm text-white/50">Submitted {money(claimItemCents(item))}</span></div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <Field label="Allowed" type="number" value={line.allowed} onChange={(value) => update(index, "allowed", value)} />
                  <Field label="Paid" type="number" value={line.paid} onChange={(value) => update(index, "paid", value)} />
                  <Field label="PR-1 deductible" type="number" value={line.deductible} onChange={(value) => update(index, "deductible", value)} />
                  <Field label="PR-2 coinsurance" type="number" value={line.coinsurance} onChange={(value) => update(index, "coinsurance", value)} />
                  <Field label="PR-3 copay" type="number" value={line.copay} onChange={(value) => update(index, "copay", value)} />
                </div>
              </section>
            );
          })}
        </div>
      </div>
      <footer className="flex justify-end gap-2 border-t border-white/10 p-4">
        <button type="button" onClick={onClose} className="rounded border border-white/15 px-4 py-2 text-white/65">Cancel</button>
        <button type="button" disabled={busy} onClick={onPost} className="rounded bg-emerald-700 px-5 py-2 font-bold disabled:opacity-50">Post claim line</button>
      </footer>
    </aside>
  );
}

function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: "text" | "date" | "number" }) {
  return (
    <label className="text-xs font-bold text-white/55">{label}
      <input type={type} min={type === "number" ? "0" : undefined} step={type === "number" ? "0.01" : undefined} inputMode={type === "number" ? "decimal" : undefined} required value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={`mt-1.5 w-full rounded border border-white/15 bg-black/30 px-3 text-sm text-white placeholder:text-white/25 ${type === "number" ? "min-h-11" : "h-10"}`} />
    </label>
  );
}

function lineInput(line: LineDraft): ManualEobLineInput {
  return {
    itemSequence: line.itemSequence,
    allowedCents: dollarsToCents(line.allowed),
    paidCents: dollarsToCents(line.paid),
    deductibleCents: dollarsToCents(line.deductible),
    coinsuranceCents: dollarsToCents(line.coinsurance),
    copayCents: dollarsToCents(line.copay),
  };
}

function claimItemCents(item: NonNullable<Claim["item"]>[number]): number {
  if (item.net?.value !== undefined) return Math.round(item.net.value * 100);
  return Math.round((item.unitPrice?.value ?? 0) * (item.quantity?.value ?? 1) * 100);
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function claimsApiOptions(): ClaimsApiOptions {
  const meta = import.meta as ImportMeta & { env?: { VITE_ODOS_MCP_BASE_URL?: string } };
  return {
    authorization: fhir.authHeader(),
    baseUrl: meta.env?.VITE_ODOS_MCP_BASE_URL?.replace(/\/$/, "") ?? "",
  };
}
