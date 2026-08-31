import { useEffect, useMemo, useState } from "react";
import type { Coverage, Patient, RelatedPerson } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import {
  buildCoverageSaveBundle,
  coverageDraftFromResource,
  emptyCoverageDraft,
  fetchPatientInsurance,
  COB_APPLICABILITY_OPTIONS,
  savePatientInsurance,
  SUBSCRIBER_RELATIONSHIPS,
  validateCoverageDraft,
  type CoverageEditorDraft,
  type InsuranceScreenData,
  type SubscriberDemographics,
} from "../../lib/patient-insurance";
import {
  coverageGroupName,
  coverageGroupNumber,
  coveragePlanName,
  coverageRelationship,
  coverageType,
} from "../../lib/submit-claims";
import { patientName } from "../../lib/scheduler-appointment-ui";
import { PatientSearch } from "../PatientPicker";

export function PatientInsurance({ initialPatientId }: { initialPatientId?: string }) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [patient, setPatient] = useState<Patient>();
  const [data, setData] = useState<InsuranceScreenData>({ coverages: [], relatedPeople: [] });
  const [draft, setDraft] = useState<CoverageEditorDraft>();
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

  const load = async (selected: Patient) => {
    if (!selected.id) return;
    setLoading(true);
    setError(undefined);
    try {
      setData(await fetchPatientInsurance(`Patient/${selected.id}`, api));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  };

  const selectPatient = (selected: Patient) => {
    if (!selected.id) return;
    setPatient(selected);
    setDraft(undefined);
    setData({ coverages: [], relatedPeople: [] });
    void load(selected);
  };

  const editCoverage = (coverage: Coverage) => {
    if (!patient) return;
    setDraft(coverageDraftFromResource(coverage, patient, relatedPersonForCoverage(coverage, data.relatedPeople)));
  };

  const save = async () => {
    if (!patient || !draft) return;
    const errors = validateCoverageDraft(draft);
    if (errors.length) {
      setError(errors.join(" "));
      return;
    }
    const existingCoverage = data.coverages.find((coverage) => coverage.id === draft.coverageId);
    const existingRelatedPerson = data.relatedPeople.find((person) => `RelatedPerson/${person.id}` === draft.subscriberReference);
    setSaving(true);
    setError(undefined);
    try {
      await savePatientInsurance(buildCoverageSaveBundle({ draft, existingCoverage, existingRelatedPerson }), api);
      setDraft(undefined);
      await load(patient);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Patient chart</p>
          <h1 className="text-2xl font-semibold">Insurance</h1>
          <p className="mt-1 text-sm text-white/50">Medical and vision plans share one Coverage editor.</p>
        </div>
        {patient && <div className="flex gap-2">
          <button type="button" onClick={() => window.location.assign(`/patient/vision-benefits?patientId=${patient.id}`)} className="rounded border border-blue-400/30 px-3 py-2 text-sm text-blue-200">Vision plan benefits</button>
          <button type="button" onClick={() => { setPatient(undefined); setDraft(undefined); setData({ coverages: [], relatedPeople: [] }); }} className="rounded border border-white/15 px-3 py-2 text-sm text-white/65">Change patient</button>
        </div>}
      </header>

      {error && <div role="alert" className="mb-4 rounded border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{error}</div>}

      {!patient ? (
        <section className="rounded-lg border border-white/10 bg-bg-panel/80 p-5">
          <h2 className="text-lg font-semibold">Select a patient</h2>
          <div className="mt-5"><PatientSearch actionLabel="View insurance" onSelect={selectPatient} /></div>
        </section>
      ) : (
        <>
          <section className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-400/20 bg-blue-950/20 px-4 py-3">
            <div><strong>{patientName(patient)}</strong><span className="ml-2 text-xs text-white/45">Patient/{patient.id}</span></div>
            <button type="button" onClick={() => setDraft(emptyCoverageDraft(`Patient/${patient.id}`, today))} className="rounded bg-blue-500 px-4 py-2 text-sm font-semibold text-white">Add coverage</button>
          </section>
          {loading ? <div className="grid min-h-52 place-items-center text-sm text-white/50">Loading insurance…</div> : <InsuranceGrid coverages={data.coverages} relatedPeople={data.relatedPeople} patient={patient} onEdit={editCoverage} />}
        </>
      )}

      {patient && draft && (
        <CoverageEditor
          draft={draft}
          patient={patient}
          relatedPeople={data.relatedPeople}
          saving={saving}
          onChange={setDraft}
          onCancel={() => setDraft(undefined)}
          onSave={() => void save()}
        />
      )}
    </main>
  );
}

export function InsuranceGrid({
  coverages,
  relatedPeople,
  patient,
  onEdit,
}: {
  coverages: readonly Coverage[];
  relatedPeople: readonly RelatedPerson[];
  patient: Patient;
  onEdit: (coverage: Coverage) => void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-bg-panel/80">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1050px] text-left text-sm">
          <thead className="bg-black/20 text-xs uppercase tracking-wide text-white/40">
            <tr><th className="px-4 py-3">Carrier / plan</th><th className="px-4 py-3">Coverage type</th><th className="px-4 py-3">Group</th><th className="px-4 py-3">Guarantor / subscriber</th><th className="px-4 py-3">Effective date</th><th className="px-4 py-3">Primary</th><th className="px-4 py-3">Active</th><th className="px-4 py-3"></th></tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {coverages.map((coverage) => {
              const relatedPerson = relatedPersonForCoverage(coverage, relatedPeople);
              const subscriber = coverageRelationship(coverage) === "self"
                ? patientName(patient)
                : relatedPerson ? relatedPersonName(relatedPerson) : "Other — details not captured";
              const group = [coverageGroupNumber(coverage), coverageGroupName(coverage)].filter(Boolean).join(" · ");
              return <tr key={coverage.id ?? coverage.identifier?.[0]?.value} className="text-white/70 hover:bg-white/5">
                <td className="px-4 py-3"><strong className="text-white/85">{coverage.payor[0]?.display ?? coverage.payor[0]?.reference ?? "Unknown carrier"}</strong><div className="text-xs text-white/40">{coveragePlanName(coverage) || "Plan not entered"}</div></td>
                <td className="px-4 py-3 capitalize">{coverageType(coverage) || "Not entered"}</td>
                <td className="px-4 py-3">{group || "—"}</td>
                <td className="px-4 py-3">{subscriber}</td>
                <td className="px-4 py-3">{coverage.period?.start ?? "—"}</td>
                <td className="px-4 py-3">{coverage.order === 1 ? "Yes" : "No"}</td>
                <td className="px-4 py-3">{coverage.status === "active" ? "Yes" : "No"}</td>
                <td className="px-4 py-3 text-right"><button type="button" onClick={() => onEdit(coverage)} className="rounded border border-white/15 px-3 py-1.5 text-xs text-white/70">Edit</button></td>
              </tr>;
            })}
          </tbody>
        </table>
        {coverages.length === 0 && <div className="px-4 py-12 text-center text-sm text-white/35">No insurance coverage recorded.</div>}
      </div>
    </section>
  );
}

export function CoverageEditor({
  draft,
  patient,
  relatedPeople,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: CoverageEditorDraft;
  patient: Patient;
  relatedPeople: readonly RelatedPerson[];
  saving: boolean;
  onChange: (draft: CoverageEditorDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof CoverageEditorDraft>(key: K, value: CoverageEditorDraft[K]) => onChange({ ...draft, [key]: value });
  const selectExistingSubscriber = (reference: string) => {
    const person = relatedPeople.find((candidate) => `RelatedPerson/${candidate.id}` === reference);
    onChange({ ...draft, subscriberReference: reference, subscriber: person ? demographicsFromRelatedPerson(person) : emptyDemographics() });
  };
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-4">
      <section className="mx-auto max-w-5xl rounded-xl border border-white/15 bg-bg-panel p-5 shadow-2xl">
        <div className="mb-5 flex items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-white/40">Coverage detail</p><h2 className="text-xl font-semibold">{draft.coverageId ? "Edit insurance" : "Add insurance"}</h2></div><button type="button" onClick={onCancel} className="text-white/50">Close</button></div>
        <fieldset className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <legend className="mb-3 text-sm font-semibold text-blue-200">Carrier information</legend>
          <Field label="Carrier name" value={draft.carrierName} onChange={(value) => set("carrierName", value)} />
          <Field label="Carrier Organization reference" value={draft.carrierReference} onChange={(value) => set("carrierReference", value)} />
          <Field label="Payer ID" value={draft.payerId} onChange={(value) => set("payerId", value)} />
          <Field label="Plan" value={draft.planName} onChange={(value) => set("planName", value)} />
          <Select label="Coverage type" value={draft.coverageType} options={[{ value: "medical", label: "Medical" }, { value: "vision", label: "Vision" }]} onChange={(value) => set("coverageType", value as "medical" | "vision")} />
          <Field label="Insured ID" value={draft.memberId} onChange={(value) => set("memberId", value)} />
          <Field label="Group number" value={draft.groupNumber} onChange={(value) => set("groupNumber", value)} />
          <Field label="Group name" value={draft.groupName} onChange={(value) => set("groupName", value)} />
          <Select label="COB check applicability" value={draft.cobApplicability} options={COB_APPLICABILITY_OPTIONS} onChange={(value) => set("cobApplicability", value as CoverageEditorDraft["cobApplicability"])} />
          <Field label="Effective date" type="date" value={draft.effectiveDate} onChange={(value) => set("effectiveDate", value)} />
          <Field label="End date" type="date" value={draft.endDate} onChange={(value) => set("endDate", value)} />
          <Check label="Primary coverage" checked={draft.primary} onChange={(value) => set("primary", value)} />
          <Check label="Active" checked={draft.active} onChange={(value) => set("active", value)} />
        </fieldset>

        <fieldset className="mt-6 border-t border-white/10 pt-5">
          <legend className="text-sm font-semibold text-blue-200">Subscriber information</legend>
          <div className="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Select label="Relationship" value={draft.relationship} options={SUBSCRIBER_RELATIONSHIPS} onChange={(value) => {
              const relationship = value as CoverageEditorDraft["relationship"];
              onChange({ ...draft, relationship, subscriberReference: relationship === "self" ? draft.patientReference : "", subscriber: relationship === "self" ? demographicsFromPatient(patient) : emptyDemographics() });
            }} />
            {draft.relationship !== "self" && <Select label="Reuse existing subscriber" value={draft.subscriberReference} options={[{ value: "", label: "Create new subscriber" }, ...relatedPeople.filter((person) => person.id).map((person) => ({ value: `RelatedPerson/${person.id}`, label: relatedPersonName(person) }))]} onChange={selectExistingSubscriber} />}
          </div>
          {draft.relationship === "self" && <p className="mt-3 rounded border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/50">Self subscriber demographics come from the Patient record and are read-only here.</p>}
          <SubscriberFields subscriber={draft.subscriber} readOnly={draft.relationship === "self"} onChange={(subscriber) => set("subscriber", subscriber)} />
        </fieldset>

        <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={onCancel} className="rounded border border-white/15 px-4 py-2 text-sm">Cancel</button><button type="button" disabled={saving} onClick={onSave} className="rounded bg-blue-500 px-4 py-2 text-sm font-semibold disabled:opacity-50">{saving ? "Saving…" : "Save coverage"}</button></div>
      </section>
    </div>
  );
}

function SubscriberFields({ subscriber, readOnly, onChange }: { subscriber: SubscriberDemographics; readOnly: boolean; onChange: (subscriber: SubscriberDemographics) => void }) {
  const set = (key: keyof SubscriberDemographics, value: string) => onChange({ ...subscriber, [key]: value });
  return <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
    <Field label="First name" value={subscriber.firstName} readOnly={readOnly} onChange={(value) => set("firstName", value)} />
    <Field label="Middle name" value={subscriber.middleName} readOnly={readOnly} onChange={(value) => set("middleName", value)} />
    <Field label="Last name" value={subscriber.lastName} readOnly={readOnly} onChange={(value) => set("lastName", value)} />
    <Field label="Birth date" type="date" value={subscriber.birthDate} readOnly={readOnly} onChange={(value) => set("birthDate", value)} />
    <Select label="Gender" value={subscriber.gender} disabled={readOnly} options={[{ value: "male", label: "Male" }, { value: "female", label: "Female" }, { value: "other", label: "Other" }, { value: "unknown", label: "Unknown" }]} onChange={(value) => set("gender", value)} />
    <Field label="Address" value={subscriber.address} readOnly={readOnly} onChange={(value) => set("address", value)} />
    <Field label="City" value={subscriber.city} readOnly={readOnly} onChange={(value) => set("city", value)} />
    <Field label="State" value={subscriber.state} readOnly={readOnly} onChange={(value) => set("state", value)} />
    <Field label="ZIP" value={subscriber.postalCode} readOnly={readOnly} onChange={(value) => set("postalCode", value)} />
  </div>;
}

function Field({ label, value, type = "text", readOnly = false, onChange }: { label: string; value: string; type?: string; readOnly?: boolean; onChange: (value: string) => void }) {
  return <label className="block text-xs font-semibold text-white/60">{label}<input type={type} value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white read-only:text-white/50" /></label>;
}

function Select({ label, value, options, disabled = false, onChange }: { label: string; value: string; options: ReadonlyArray<{ value: string; label: string }>; disabled?: boolean; onChange: (value: string) => void }) {
  return <label className="block text-xs font-semibold text-white/60">{label}<select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white disabled:text-white/50">{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-center gap-2 pt-6 text-sm text-white/70"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function relatedPersonForCoverage(coverage: Coverage, relatedPeople: readonly RelatedPerson[]): RelatedPerson | undefined {
  return relatedPeople.find((person) => `RelatedPerson/${person.id}` === coverage.subscriber?.reference);
}

function relatedPersonName(person: RelatedPerson): string {
  const name = person.name?.[0];
  return [...(name?.given ?? []), name?.family].filter(Boolean).join(" ") || `RelatedPerson/${person.id ?? "unknown"}`;
}

function demographicsFromPatient(patient: Patient): SubscriberDemographics {
  const name = patient.name?.[0];
  const address = patient.address?.[0];
  return { firstName: name?.given?.[0] ?? "", middleName: name?.given?.slice(1).join(" ") ?? "", lastName: name?.family ?? "", birthDate: patient.birthDate ?? "", gender: patient.gender ?? "unknown", address: address?.line?.join(" ") ?? "", city: address?.city ?? "", state: address?.state ?? "", postalCode: address?.postalCode ?? "" };
}

function demographicsFromRelatedPerson(person: RelatedPerson): SubscriberDemographics {
  const name = person.name?.[0];
  const address = person.address?.[0];
  return { firstName: name?.given?.[0] ?? "", middleName: name?.given?.slice(1).join(" ") ?? "", lastName: name?.family ?? "", birthDate: person.birthDate ?? "", gender: person.gender ?? "unknown", address: address?.line?.join(" ") ?? "", city: address?.city ?? "", state: address?.state ?? "", postalCode: address?.postalCode ?? "" };
}

function emptyDemographics(): SubscriberDemographics {
  return { firstName: "", middleName: "", lastName: "", birthDate: "", gender: "unknown", address: "", city: "", state: "", postalCode: "" };
}

function insuranceApiOptions() {
  return { authorization: fhir.authHeader(), baseUrl: import.meta.env.VITE_ODOS_MCP_BASE_URL?.replace(/\/$/, "") ?? "" };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
