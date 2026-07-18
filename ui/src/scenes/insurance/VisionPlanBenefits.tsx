import { Fragment, useEffect, useMemo, useState } from "react";
import type { Coverage, CoverageEligibilityResponse, Patient } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import {
  applyPlanTemplate,
  loadInsuranceConfigSingleton,
  type PlanTemplate,
} from "../../lib/insurance-config";
import {
  BENEFIT_KINDS,
  benefitAllowanceDollars,
  benefitCopayDollars,
  benefitFrequencyMonths,
  benefitItem,
  benefitLastUsed,
  benefitUsedDollars,
  buildManualBenefitsBundle,
  deriveBenefitStatus,
  emptyManualBenefitsDraft,
  fetchPatientInsurance,
  fetchVisionBenefits,
  latestBenefitsByCoverage,
  nextEligibleDate,
  saveVisionBenefits,
  validateManualBenefitsDraft,
  type BenefitEntryDraft,
  type BenefitKind,
  type BenefitStatus,
  type ManualBenefitsDraft,
} from "../../lib/patient-insurance";
import { coveragePlanName } from "../../lib/submit-claims";
import { patientName } from "../../lib/scheduler-appointment-ui";
import { PatientSearch } from "../PatientPicker";

export function VisionPlanBenefits({ initialPatientId }: { initialPatientId?: string }) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [patient, setPatient] = useState<Patient>();
  const [coverages, setCoverages] = useState<Coverage[]>([]);
  const [responses, setResponses] = useState<CoverageEligibilityResponse[]>([]);
  const [expandedCoverage, setExpandedCoverage] = useState<string>();
  const [historyCoverage, setHistoryCoverage] = useState<string>();
  const [draft, setDraft] = useState<ManualBenefitsDraft>();
  const [planTemplates, setPlanTemplates] = useState<PlanTemplate[]>([]);
  const [templateError, setTemplateError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const api = insuranceApiOptions();

  useEffect(() => {
    if (!initialPatientId) return;
    let cancelled = false;
    void fhir.read<Patient>("Patient", initialPatientId)
      .then((loaded) => { if (!cancelled) selectPatient(loaded); })
      .catch((cause) => { if (!cancelled) setError(messageOf(cause)); });
    return () => { cancelled = true; };
  }, [initialPatientId]);

  useEffect(() => {
    let cancelled = false;
    void loadInsuranceConfigSingleton(fhir)
      .then(({ config }) => {
        if (!cancelled) {
          setPlanTemplates(config.planTemplates.filter((template) => template.active !== false));
          setTemplateError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setTemplateError(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = async (selected: Patient) => {
    if (!selected.id) return;
    setLoading(true);
    setError(undefined);
    try {
      const patientReference = `Patient/${selected.id}`;
      const [insurance, benefits] = await Promise.all([
        fetchPatientInsurance(patientReference, api),
        fetchVisionBenefits(patientReference, api),
      ]);
      setCoverages(insurance.coverages);
      setResponses(benefits.responses);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  };

  const selectPatient = (selected: Patient) => {
    if (!selected.id) return;
    setPatient(selected);
    setCoverages([]);
    setResponses([]);
    setDraft(undefined);
    void load(selected);
  };

  const save = async () => {
    if (!patient || !draft) return;
    const errors = validateManualBenefitsDraft(draft);
    if (errors.length) {
      setError(errors.join(" "));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await saveVisionBenefits(buildManualBenefitsBundle(draft, { created: new Date().toISOString() }), api);
      setDraft(undefined);
      await load(patient);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const latest = latestBenefitsByCoverage(responses);
  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Patient chart · Insurance</p>
          <h1 className="text-2xl font-semibold">Vision plan benefits</h1>
          <p className="mt-1 text-sm text-white/50">Manual staff entry with a paired eligibility request and response history.</p>
        </div>
        {patient && <div className="flex gap-2"><button type="button" onClick={() => window.location.assign(`/patient/insurance?patientId=${patient.id}`)} className="rounded border border-blue-400/30 px-3 py-2 text-sm text-blue-200">Insurance</button><button type="button" onClick={() => { setPatient(undefined); setCoverages([]); setResponses([]); }} className="rounded border border-white/15 px-3 py-2 text-sm text-white/65">Change patient</button></div>}
      </header>

      <div className="mb-4 rounded border border-amber-300/20 bg-amber-950/20 px-4 py-3 text-sm text-amber-100/80">Manual entry only. This screen does not run or import automated vision eligibility.</div>
      {error && <div role="alert" className="mb-4 rounded border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{error}</div>}

      {!patient ? (
        <section className="rounded-lg border border-white/10 bg-bg-panel/80 p-5"><h2 className="text-lg font-semibold">Select a patient</h2><div className="mt-5"><PatientSearch actionLabel="View benefits" onSelect={selectPatient} /></div></section>
      ) : (
        <>
          <section className="mb-4 rounded-lg border border-blue-400/20 bg-blue-950/20 px-4 py-3"><strong>{patientName(patient)}</strong><span className="ml-2 text-xs text-white/45">Patient/{patient.id}</span></section>
          {loading ? <div className="grid min-h-52 place-items-center text-sm text-white/50">Loading vision benefits…</div> : (
            <BenefitsTable
              coverages={coverages}
              latest={latest}
              responses={responses}
              today={today}
              expandedCoverage={expandedCoverage}
              historyCoverage={historyCoverage}
              onToggleBenefits={(reference) => setExpandedCoverage(expandedCoverage === reference ? undefined : reference)}
              onToggleHistory={(reference) => setHistoryCoverage(historyCoverage === reference ? undefined : reference)}
              onManualEntry={(coverage) => setDraft(emptyManualBenefitsDraft(`Patient/${patient.id}`, coverage, today))}
            />
          )}
        </>
      )}

      {draft && <ManualBenefitsEditor draft={draft} planTemplates={planTemplates} templateError={templateError} saving={saving} onChange={setDraft} onCancel={() => setDraft(undefined)} onSave={() => void save()} />}
    </main>
  );
}

export function BenefitsTable({
  coverages,
  latest,
  responses,
  today,
  expandedCoverage,
  historyCoverage,
  onToggleBenefits,
  onToggleHistory,
  onManualEntry,
}: {
  coverages: readonly Coverage[];
  latest: ReadonlyMap<string, CoverageEligibilityResponse>;
  responses: readonly CoverageEligibilityResponse[];
  today: string;
  expandedCoverage?: string;
  historyCoverage?: string;
  onToggleBenefits: (reference: string) => void;
  onToggleHistory: (reference: string) => void;
  onManualEntry: (coverage: Coverage) => void;
}) {
  return <section className="overflow-hidden rounded-lg border border-white/10 bg-bg-panel/80">
    <div className="overflow-x-auto"><table className="w-full min-w-[1500px] text-left text-xs">
      <thead className="bg-black/20 uppercase tracking-wide text-white/40"><tr><th className="px-3 py-3">Carrier</th><th className="px-3 py-3">Effective Date</th>{BENEFIT_KINDS.map((kind) => <th key={kind} className="px-3 py-3">{benefitLabel(kind)}</th>)}<th className="px-3 py-3">Eligibility</th><th className="px-3 py-3 text-right">Allowance</th><th className="px-3 py-3">Reuse Auth</th><th className="px-3 py-3">Benefits</th><th className="px-3 py-3"></th></tr></thead>
      <tbody className="divide-y divide-white/10">{coverages.map((coverage) => {
        const reference = `Coverage/${coverage.id}`;
        const response = latest.get(reference);
        const insurance = response?.insurance?.[0];
        const allowance = BENEFIT_KINDS.reduce((sum, kind) => sum + benefitAllowanceDollars(benefitItem(response ?? emptyResponse(), kind)), 0);
        const history = responses.filter((candidate) => candidate.insurance?.[0]?.coverage.reference === reference);
        return <Fragment key={reference}>
          <tr className="text-white/70 hover:bg-white/5">
            <td className="px-3 py-3"><strong>{coverage.payor[0]?.display ?? coverage.payor[0]?.reference ?? "Unknown"}</strong><div className="text-white/35">{coveragePlanName(coverage) || "Plan not entered"}</div></td>
            <td className="px-3 py-3">{insurance?.benefitPeriod?.start ?? "—"}</td>
            {BENEFIT_KINDS.map((kind) => <td key={kind} className="px-3 py-3"><Status value={deriveBenefitStatus(response ?? emptyResponse(), benefitItem(response ?? emptyResponse(), kind), today)} /></td>)}
            <td className="px-3 py-3">{response ? (insurance?.inforce ? "Active" : "Expired") : "—"}</td>
            <td className="px-3 py-3 text-right">{response ? money(allowance) : "—"}</td>
            <td className="px-3 py-3">{response?.preAuthRef || "—"}</td>
            <td className="px-3 py-3"><button type="button" onClick={() => onToggleBenefits(reference)} className="text-blue-300 underline">{expandedCoverage === reference ? "Hide" : "View"}</button></td>
            <td className="px-3 py-3"><div className="flex gap-2"><button type="button" onClick={() => onToggleHistory(reference)} className="text-white/60 underline">History ({history.length})</button><button type="button" onClick={() => onManualEntry(coverage)} className="rounded bg-blue-500 px-2 py-1 font-semibold text-white">Manual entry</button></div></td>
          </tr>
          {expandedCoverage === reference && <tr key={`${reference}-benefits`}><td colSpan={15} className="bg-black/20 p-4"><BenefitDetails response={response} /></td></tr>}
          {historyCoverage === reference && <tr key={`${reference}-history`}><td colSpan={15} className="bg-black/20 p-4"><History responses={history} /></td></tr>}
        </Fragment>;
      })}</tbody>
    </table></div>
    {coverages.length === 0 && <div className="px-4 py-12 text-center text-sm text-white/35">Add insurance coverage before recording benefits.</div>}
  </section>;
}

function BenefitDetails({ response }: { response?: CoverageEligibilityResponse }) {
  if (!response) return <div className="text-sm text-white/40">No manual benefit entry recorded.</div>;
  const kinds: BenefitKind[] = ["exam", "frame", "lens", "contacts"];
  return <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{kinds.map((kind) => {
    const item = benefitItem(response, kind);
    return <article key={kind} className="rounded border border-white/10 bg-bg-panel/70 p-3"><h3 className="font-semibold text-blue-200">{benefitLabel(kind)}</h3><dl className="mt-2 grid gap-1 text-sm text-white/60"><Detail label="Allowance" value={money(benefitAllowanceDollars(item))} /><Detail label="Copay" value={money(benefitCopayDollars(item))} /><Detail label="Used" value={money(benefitUsedDollars(item))} /><Detail label="Last used" value={benefitLastUsed(item) || "—"} /><Detail label="Frequency" value={benefitFrequencyMonths(item) ? `${benefitFrequencyMonths(item)} months` : "—"} /><Detail label="Next eligible" value={nextEligibleDate(item) || "—"} /></dl></article>;
  })}</div>;
}

function History({ responses }: { responses: readonly CoverageEligibilityResponse[] }) {
  if (!responses.length) return <div className="text-sm text-white/40">No history.</div>;
  return <div className="grid gap-2">{[...responses].sort((a, b) => b.created.localeCompare(a.created)).map((response) => <div key={response.id ?? response.request.reference} className="flex flex-wrap justify-between gap-2 rounded border border-white/10 px-3 py-2 text-sm text-white/60"><span>{response.created}</span><span>{response.insurance?.[0]?.inforce ? "Eligibility active" : "Eligibility expired"}</span><span>{response.request.reference}</span></div>)}</div>;
}

function ManualBenefitsEditor({ draft, planTemplates, templateError, saving, onChange, onCancel, onSave }: { draft: ManualBenefitsDraft; planTemplates: readonly PlanTemplate[]; templateError?: string; saving: boolean; onChange: (draft: ManualBenefitsDraft) => void; onCancel: () => void; onSave: () => void }) {
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const set = <K extends keyof ManualBenefitsDraft>(key: K, value: ManualBenefitsDraft[K]) => onChange({ ...draft, [key]: value });
  const setBenefit = (index: number, next: BenefitEntryDraft) => set("benefits", draft.benefits.map((benefit, candidate) => candidate === index ? next : benefit));
  return <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-4"><section className="mx-auto max-w-6xl rounded-xl border border-white/15 bg-bg-panel p-5 shadow-2xl">
    <div className="mb-5 flex justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-white/40">Staff-authored eligibility history</p><h2 className="text-xl font-semibold">Manual vision benefits</h2></div><button type="button" onClick={onCancel} className="text-white/50">Close</button></div>
    <div className="mb-5 flex flex-wrap items-end gap-3 rounded border border-blue-400/20 bg-blue-950/20 p-3">
      <label className="min-w-64 flex-1 text-xs font-semibold text-blue-100/75">Apply template
        <select
          value={selectedTemplateId}
          onChange={(event) => {
            const templateId = event.target.value;
            setSelectedTemplateId(templateId);
            const template = planTemplates.find((candidate) => candidate.id === templateId);
            if (template) onChange(applyPlanTemplate(draft, template));
          }}
          className="mt-1 w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
        >
          <option value="">Choose an active template…</option>
          {planTemplates.map((template) => <option key={template.id} value={template.id}>{template.label}{template.payerDisplay ? ` · ${template.payerDisplay}` : ""}</option>)}
        </select>
      </label>
      <a href="/settings/vision-plan-templates" className="rounded border border-blue-400/30 px-3 py-2 text-sm text-blue-200">Manage templates</a>
      <p className="w-full text-xs text-white/45">Copies plan-level values into this manual draft. Used amounts and last-used dates stay patient-specific.</p>
      {templateError && <p role="alert" className="w-full text-xs text-amber-200">Templates unavailable: {templateError}</p>}
    </div>
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4"><Field label="Effective date" type="date" value={draft.effectiveDate} onChange={(value) => set("effectiveDate", value)} /><Field label="Expiration date" type="date" value={draft.endDate} onChange={(value) => set("endDate", value)} /><Field label="Authorization reference" value={draft.authorizationReference} onChange={(value) => set("authorizationReference", value)} /><label className="flex items-center gap-2 pt-6 text-sm text-white/70"><input type="checkbox" checked={draft.eligibilityActive} onChange={(event) => set("eligibilityActive", event.target.checked)} />Eligibility active</label></div>
    <div className="mt-5 grid gap-3 lg:grid-cols-2">{draft.benefits.map((benefit, index) => <BenefitEditor key={benefit.kind} benefit={benefit} onChange={(next) => setBenefit(index, next)} />)}</div>
    <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={onCancel} className="rounded border border-white/15 px-4 py-2 text-sm">Cancel</button><button type="button" disabled={saving} onClick={onSave} className="rounded bg-blue-500 px-4 py-2 text-sm font-semibold disabled:opacity-50">{saving ? "Saving…" : "Save manual entry"}</button></div>
  </section></div>;
}

function BenefitEditor({ benefit, onChange }: { benefit: BenefitEntryDraft; onChange: (benefit: BenefitEntryDraft) => void }) {
  const set = <K extends keyof BenefitEntryDraft>(key: K, value: BenefitEntryDraft[K]) => onChange({ ...benefit, [key]: value });
  return <fieldset className="rounded border border-white/10 bg-black/20 p-3"><legend className="px-1 font-semibold text-blue-200">{benefitLabel(benefit.kind)}</legend><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><Field label="Allowance" value={benefit.allowanceDollars} onChange={(value) => set("allowanceDollars", value)} /><Field label="Copay" value={benefit.copayDollars} onChange={(value) => set("copayDollars", value)} /><Field label="Used" value={benefit.usedDollars} onChange={(value) => set("usedDollars", value)} /><Field label="Last used" type="date" value={benefit.lastUsed} onChange={(value) => set("lastUsed", value)} /><Field label="Frequency months" type="number" value={benefit.frequencyMonths} onChange={(value) => set("frequencyMonths", value)} /><label className="flex items-center gap-2 pt-6 text-sm text-white/60"><input type="checkbox" checked={benefit.excluded} onChange={(event) => set("excluded", event.target.checked)} />Does not exist</label></div></fieldset>;
}

function Status({ value }: { value: BenefitStatus }) {
  const colors: Record<BenefitStatus, string> = { "Does not Exist": "border-white/15 text-white/40", Authorized: "border-blue-400/30 text-blue-200", "Authorization Expired": "border-amber-400/30 text-amber-200", Used: "border-purple-400/30 text-purple-200", "Eligibility Active": "border-emerald-400/30 text-emerald-200", "Eligibility Expired": "border-red-400/30 text-red-200" };
  return <span className={`inline-block rounded border px-2 py-1 ${colors[value]}`}>{value}</span>;
}

function Detail({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3"><dt>{label}</dt><dd className="text-white/80">{value}</dd></div>; }
function Field({ label, value, type = "text", onChange }: { label: string; value: string; type?: string; onChange: (value: string) => void }) { return <label className="block text-xs font-semibold text-white/60">{label}<input type={type} min={type === "number" ? "1" : undefined} step={type === "number" ? "1" : undefined} value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white" /></label>; }
function benefitLabel(kind: BenefitKind): string { return kind === "contact-exam" ? "Contact Exam" : `${kind[0].toUpperCase()}${kind.slice(1)}`; }
function money(value: number): string { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value); }
function emptyResponse(): CoverageEligibilityResponse { return { resourceType: "CoverageEligibilityResponse", status: "active", purpose: ["benefits"], patient: {}, created: "", request: {}, outcome: "complete", insurer: {} }; }
function insuranceApiOptions() { return { authorization: fhir.authHeader(), baseUrl: import.meta.env.VITE_ODOS_MCP_BASE_URL?.replace(/\/$/, "") ?? "" }; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
