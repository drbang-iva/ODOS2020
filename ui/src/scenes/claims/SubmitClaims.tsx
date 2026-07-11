import { useEffect, useMemo, useRef, useState } from "react";
import type { Coverage, Patient, RelatedPerson } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import { patientName } from "../../lib/scheduler-appointment-ui";
import {
  addChargeLine,
  addDiagnosisLine,
  buildCoverageResource,
  buildProfessionalClaimInput,
  claimPersonFromPatient,
  coverageIsSelf,
  coverageLabel,
  emptyPerson,
  initialClaimDraft,
  removeChargeLine,
  removeDiagnosisLine,
  resolveSubscriberFromCoverage,
  submitProfessionalClaim,
  subscriberFromCoverage,
  validateClaimDraft,
  type ChargeLine,
  type ClaimDraft,
  type ClaimMdPersonInput,
  type ClaimMdProviderInput,
  type CoverageEntryInput,
  type DiagnosisLine,
  type ProfessionalClaimInput,
  type SubmitClaimResult,
} from "../../lib/submit-claims";
import { PatientSearch } from "../PatientPicker";

type Step = "compose" | "review" | "success";

export function SubmitClaims() {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [draft, setDraft] = useState<ClaimDraft>(() => initialClaimDraft(today));
  const [patient, setPatient] = useState<Patient>();
  const [choosingPatient, setChoosingPatient] = useState(true);
  const [coverages, setCoverages] = useState<Coverage[]>([]);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState<string>();
  const [subscriberLoading, setSubscriberLoading] = useState(false);
  const [subscriberError, setSubscriberError] = useState<string>();
  const subscriberSelection = useRef(0);
  const [showCoverageEntry, setShowCoverageEntry] = useState(false);
  const [coverageEntry, setCoverageEntry] = useState<CoverageEntryInput>(() => emptyCoverageEntry(today));
  const [step, setStep] = useState<Step>("compose");
  const [reviewClaim, setReviewClaim] = useState<ProfessionalClaimInput>();
  const [errors, setErrors] = useState<string[]>([]);
  const [submissionError, setSubmissionError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitClaimResult>();

  useEffect(() => {
    const patientId = patient?.id;
    if (!patientId) return;
    let cancelled = false;
    async function loadCoverages() {
      setCoverageLoading(true);
      setCoverageError(undefined);
      try {
        const bundle = await fhir.search<Coverage>("Coverage", {
          beneficiary: `Patient/${patientId}`,
          _count: "50",
        });
        if (!cancelled) {
          setCoverages((bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
        }
      } catch (cause) {
        if (!cancelled) {
          setCoverageError(cause instanceof Error ? cause.message : String(cause));
          setCoverages([]);
        }
      } finally {
        if (!cancelled) setCoverageLoading(false);
      }
    }
    void loadCoverages();
    return () => {
      cancelled = true;
    };
  }, [patient?.id]);

  const selectedCoverage = coverages.find((coverage) => `Coverage/${coverage.id}` === draft.coverageReference);

  const selectPatient = (selected: Patient) => {
    if (!selected.id) return;
    setPatient(selected);
    setChoosingPatient(false);
    setCoverages([]);
    setShowCoverageEntry(false);
    subscriberSelection.current += 1;
    setSubscriberError(undefined);
    setSubscriberLoading(false);
    setCoverageEntry(emptyCoverageEntry(today, `Patient/${selected.id}`));
    setDraft((current) => ({
      ...current,
      patientReference: `Patient/${selected.id}`,
      patient: claimPersonFromPatient(selected),
      subscriber: emptyPerson(),
      coverageReference: "",
      insurerReference: "",
    }));
  };

  const selectCoverage = async (coverage: Coverage) => {
    if (!coverage.id || !patient) return;
    const selection = subscriberSelection.current + 1;
    subscriberSelection.current = selection;
    const coverageReference = `Coverage/${coverage.id}`;
    setSubscriberLoading(true);
    setSubscriberError(undefined);
    setDraft((current) => ({
      ...current,
      coverageReference,
      insurerReference: coverage.payor[0]?.reference ?? "",
      subscriber: subscriberFromCoverage(coverage, patient),
    }));
    const resolution = await resolveSubscriberFromCoverage(
      coverage,
      patient,
      (id) => fhir.read<RelatedPerson>("RelatedPerson", id),
    );
    if (subscriberSelection.current !== selection) return;
    setDraft((current) => current.coverageReference === coverageReference
      ? { ...current, subscriber: resolution.subscriber }
      : current);
    setSubscriberError(resolution.error);
    setSubscriberLoading(false);
  };

  const createCoverage = async () => {
    const entryErrors = validateCoverageEntry(coverageEntry);
    if (entryErrors.length) {
      setCoverageError(entryErrors.join(" "));
      return;
    }
    setCoverageError(undefined);
    try {
      const created = await fhir.create(buildCoverageResource(coverageEntry), "submit-claims-coverage");
      setCoverages((current) => [created, ...current]);
      await selectCoverage(created);
      setShowCoverageEntry(false);
    } catch (cause) {
      setCoverageError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openReview = () => {
    const nextErrors = validateClaimDraft(draft);
    setErrors(nextErrors);
    if (nextErrors.length) return;
    setReviewClaim(buildProfessionalClaimInput(draft));
    setSubmissionError(undefined);
    setStep("review");
    window.scrollTo({ top: 0 });
  };

  const submit = async () => {
    if (!reviewClaim) return;
    setSubmitting(true);
    setSubmissionError(undefined);
    try {
      const submitted = await submitProfessionalClaim(reviewClaim, {
        authorization: fhir.authHeader(),
        baseUrl: claimApiBaseUrl(),
      });
      setResult(submitted);
      setStep("success");
    } catch (cause) {
      setSubmissionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const startAnother = () => {
    setDraft(initialClaimDraft(today));
    setPatient(undefined);
    setChoosingPatient(true);
    setCoverages([]);
    setCoverageEntry(emptyCoverageEntry(today));
    subscriberSelection.current += 1;
    setSubscriberError(undefined);
    setSubscriberLoading(false);
    setReviewClaim(undefined);
    setErrors([]);
    setSubmissionError(undefined);
    setResult(undefined);
    setStep("compose");
  };

  return (
    <main className="min-h-screen bg-bg-deep px-5 py-6 text-white">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Claims management</p>
            <h1 className="text-2xl font-semibold">Compose and submit claim</h1>
            <p className="mt-1 text-sm text-white/50">Single professional claim · configured clearinghouse</p>
          </div>
          <ol className="flex gap-2 text-xs font-bold uppercase tracking-wide text-white/40">
            <StepLabel active={step === "compose"} value="1 Compose" />
            <StepLabel active={step === "review"} value="2 Review" />
            <StepLabel active={step === "success"} value="3 Result" />
          </ol>
        </header>

        {step === "compose" && (
          <div className="space-y-5">
            <Section title="Patient" description="Select the patient whose demographics should prefill this claim.">
              {patient && !choosingPatient ? (
                <div className="flex items-center justify-between rounded-md border border-blue-400/30 bg-blue-950/20 p-4">
                  <div>
                    <div className="font-semibold">{patientName(patient)}</div>
                    <div className="mt-1 text-xs text-white/45">{draft.patientReference} · DOB {patient.birthDate ?? "manual entry required"}</div>
                  </div>
                  <button type="button" onClick={() => setChoosingPatient(true)} className="rounded border border-white/15 px-3 py-2 text-sm text-white/70">Change</button>
                </div>
              ) : (
                <PatientSearch onSelect={selectPatient} />
              )}
            </Section>

            {patient && !choosingPatient && (
              <>
                <Section title="Coverage" description="Existing Coverages are loaded by beneficiary. Create the minimum policy record when needed.">
                  {coverageError && <SubmissionAlert message={coverageError} />}
                  {coverageLoading ? (
                    <p className="text-sm text-white/45">Loading Coverage records…</p>
                  ) : (
                    <div className="space-y-2">
                      <CoverageChoices
                        coverages={coverages}
                        selectedReference={draft.coverageReference}
                        onSelect={selectCoverage}
                      />
                      {coverages.length === 0 && <p className="text-sm text-white/45">No Coverage records found for this patient.</p>}
                    </div>
                  )}
                  <button type="button" onClick={() => setShowCoverageEntry((value) => !value)} className="mt-3 rounded bg-blue-700 px-3 py-2 text-sm font-semibold">
                    {showCoverageEntry ? "Cancel Coverage entry" : "Add Coverage"}
                  </button>
                  {showCoverageEntry && (
                    <div className="mt-4 grid gap-3 rounded border border-white/10 bg-black/20 p-4 md:grid-cols-2">
                      <Field label="Payor Organization reference" value={coverageEntry.payorReference} placeholder="Organization/123" onChange={(value) => setCoverageEntry((current) => ({ ...current, payorReference: value }))} />
                      <Field label="Payor display name" value={coverageEntry.payorDisplay ?? ""} onChange={(value) => setCoverageEntry((current) => ({ ...current, payorDisplay: value }))} />
                      <Field label="Member ID" value={coverageEntry.memberId} onChange={(value) => setCoverageEntry((current) => ({ ...current, memberId: value }))} />
                      <Field label="Group number" value={coverageEntry.groupNumber} onChange={(value) => setCoverageEntry((current) => ({ ...current, groupNumber: value }))} />
                      <SelectField label="Relationship" value={coverageEntry.relationship} options={[{ value: "self", label: "Subscriber is patient" }, { value: "other", label: "Other subscriber" }]} onChange={(value) => setCoverageEntry((current) => ({ ...current, relationship: value as "self" | "other" }))} />
                      <Field label="Effective date" type="date" value={coverageEntry.effectiveDate} onChange={(value) => setCoverageEntry((current) => ({ ...current, effectiveDate: value }))} />
                      <button type="button" onClick={() => void createCoverage()} className="rounded bg-emerald-700 px-3 py-2 text-sm font-semibold md:col-span-2">Create and select Coverage</button>
                    </div>
                  )}
                </Section>

                <Section title="Claim details" description="FHIR references and clearinghouse identifiers for this submission.">
                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                    <Field label="FHIR provider reference" value={draft.providerReference} placeholder="Practitioner/123" onChange={(value) => setDraft((current) => ({ ...current, providerReference: value }))} />
                    <Field label="Payer ID" value={draft.payerId} onChange={(value) => setDraft((current) => ({ ...current, payerId: value }))} />
                    <Field label="Patient account number" value={draft.patientAccountNumber} onChange={(value) => setDraft((current) => ({ ...current, patientAccountNumber: value }))} />
                    <Field label="Service date" type="date" value={draft.serviceDate} onChange={(value) => setDraft((current) => ({ ...current, serviceDate: value }))} />
                    <Field label="Created date" type="date" value={draft.created} onChange={(value) => setDraft((current) => ({ ...current, created: value }))} />
                    <ReadOnlyField label="Insurer reference" value={draft.insurerReference || "Select Coverage"} />
                  </div>
                </Section>

                <Section title="Billing provider" description="Typed per claim until the practice billing-identity singleton exists.">
                  <ProviderFields provider={draft.billingProvider} onChange={(billingProvider) => setDraft((current) => ({ ...current, billingProvider }))} />
                </Section>

                <Section title="Rendering provider" description="NPI is required; remaining clearinghouse fields are optional.">
                  <ProviderFields provider={draft.renderingProvider} onChange={(renderingProvider) => setDraft((current) => ({ ...current, renderingProvider }))} />
                </Section>

                <Section title="Patient demographics" description="Available FHIR Patient fields are prefilled and remain editable when the stored record is incomplete.">
                  <PersonFields person={draft.patient} onChange={(next) => setDraft((current) => ({ ...current, patient: next }))} />
                </Section>

                <Section title="Subscriber demographics" description={selectedCoverage && coverageIsSelf(selectedCoverage) ? "Self relationship: copied from the selected patient." : "Other relationship: stored subscriber demographics are prefilled and remain editable."}>
                  {subscriberError && <div className="mb-3"><SubmissionAlert message={subscriberError} /></div>}
                  {subscriberLoading && <p className="mb-3 text-sm text-white/45">Loading subscriber record…</p>}
                  {selectedCoverage && coverageIsSelf(selectedCoverage) ? (
                    <PersonSummary person={draft.subscriber} />
                  ) : (
                    <PersonFields person={draft.subscriber} includePolicy onChange={(next) => setDraft((current) => ({ ...current, subscriber: next }))} />
                  )}
                </Section>

                <Section title="Diagnoses" description="Staff-entered ICD-10-CM. This phase does not validate code validity or provide a catalog.">
                  <DiagnosisLines lines={draft.diagnoses} onChange={(diagnoses) => setDraft((current) => ({ ...current, diagnoses }))} />
                </Section>

                <Section title="Charges" description="Staff-entered CPT/HCPCS. Fees are entered in dollars and sent as FHIR USD Money.">
                  <ChargeLines lines={draft.charges} onChange={(charges) => setDraft((current) => ({ ...current, charges }))} />
                </Section>

                {errors.length > 0 && <SubmissionAlert message={errors.join(" ")} />}
                <div className="flex justify-end">
                  <button type="button" onClick={openReview} className="rounded bg-blue-600 px-5 py-3 font-semibold">Review claim</button>
                </div>
              </>
            )}
          </div>
        )}

        {step === "review" && reviewClaim && (
          <ClaimReview
            claim={reviewClaim}
            error={submissionError}
            submitting={submitting}
            onEdit={() => setStep("compose")}
            onSubmit={() => void submit()}
          />
        )}

        {step === "success" && result && (
          <ClaimSubmissionResult result={result} onAnother={startAnother} />
        )}
      </div>
    </main>
  );
}

export function SubmissionAlert({ message }: { message: string }) {
  return <div role="alert" className="rounded border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{message}</div>;
}

export function CoverageChoices({
  coverages,
  selectedReference,
  onSelect,
}: {
  coverages: readonly Coverage[];
  selectedReference: string;
  onSelect: (coverage: Coverage) => void | Promise<void>;
}) {
  return coverages.map((coverage) => (
    <label key={coverage.id} className="flex cursor-pointer items-start gap-3 rounded border border-white/10 bg-black/20 p-3">
      <input
        type="radio"
        name="coverage"
        checked={`Coverage/${coverage.id}` === selectedReference}
        onChange={() => onSelect(coverage)}
        className="mt-1"
      />
      <span>
        <span className="block text-sm font-semibold text-white/80">{coverageLabel(coverage)}</span>
        <span className="mt-1 block text-xs text-white/40">{coverage.period?.start ?? "No effective date"} · {coverageIsSelf(coverage) ? "Subscriber is patient" : "Other subscriber"}</span>
      </span>
    </label>
  ));
}

export function ClaimSubmissionResult({ result, onAnother }: { result: SubmitClaimResult; onAnother: () => void }) {
  return (
    <section className="rounded-lg border border-emerald-400/30 bg-emerald-950/20 p-6">
      <p className="text-xs font-bold uppercase tracking-wide text-emerald-300">Submitted</p>
      <h2 className="mt-1 text-xl font-semibold">Claim accepted for clearinghouse submission</h2>
      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
        <Detail label="FHIR Claim ID" value={result.claimId ?? "Not returned"} />
        <Detail label="Clearinghouse" value={result.clearinghouse === "stedi" ? "Stedi" : "Claim.MD"} />
        <Detail label="Status" value={result.status ?? "Not returned"} />
        <Detail label="Clearinghouse claim ID" value={result.claimMdClaimId ?? result.stediCorrelationId ?? "Not returned"} />
        <Detail label="Tracking number" value={result.claimMdTrackingNumber ?? result.stediTrackingNumber ?? "Not returned"} />
      </dl>
      <button type="button" onClick={onAnother} className="mt-6 rounded bg-emerald-700 px-4 py-2 font-semibold">Compose another claim</button>
    </section>
  );
}

export function ClaimReview({
  claim,
  error,
  submitting,
  onEdit,
  onSubmit,
}: {
  claim: ProfessionalClaimInput;
  error?: string;
  submitting: boolean;
  onEdit: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-bg-panel/80 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Review assembled claim</h2>
          <p className="mt-1 text-sm text-white/45">Read-only ProfessionalClaimInput sent to POST /claims/submit.</p>
        </div>
        <button type="button" onClick={onEdit} disabled={submitting} className="rounded border border-white/15 px-3 py-2 text-sm text-white/70 disabled:opacity-50">Back to edit</button>
      </div>
      <pre className="mt-5 max-h-[60vh] overflow-auto rounded bg-black/35 p-4 text-xs leading-relaxed text-white/70">{JSON.stringify(claim, null, 2)}</pre>
      {error && <div className="mt-4"><SubmissionAlert message={error} /></div>}
      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onSubmit} disabled={submitting} className="rounded bg-emerald-700 px-5 py-3 font-semibold disabled:opacity-50">{submitting ? "Submitting…" : "Submit claim"}</button>
      </div>
    </section>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-white/10 bg-bg-panel/80 p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 text-xs text-white/45">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function StepLabel({ active, value }: { active: boolean; value: string }) {
  return <li className={active ? "rounded bg-blue-500/20 px-2 py-1 text-blue-200" : "px-2 py-1"}>{value}</li>;
}

function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="block text-xs font-semibold text-white/60">
      {label}
      <input type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-blue-400" />
    </label>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return <div className="text-xs font-semibold text-white/60"><div>{label}</div><div className="mt-1 min-h-9 rounded border border-white/10 bg-black/20 px-3 py-2 text-sm font-normal text-white/55">{value}</div></div>;
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <label className="block text-xs font-semibold text-white/60">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white">
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function ProviderFields({ provider, onChange }: { provider: ClaimMdProviderInput; onChange: (provider: ClaimMdProviderInput) => void }) {
  const set = (key: keyof ClaimMdProviderInput, value: string) => onChange({ ...provider, [key]: value });
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      <Field label="Organization/name" value={provider.name ?? ""} onChange={(value) => set("name", value)} />
      <Field label="First name" value={provider.firstName ?? ""} onChange={(value) => set("firstName", value)} />
      <Field label="Last name" value={provider.lastName ?? ""} onChange={(value) => set("lastName", value)} />
      <Field label="NPI" value={provider.npi} onChange={(value) => set("npi", value)} />
      <Field label="Tax ID" value={provider.taxId ?? ""} onChange={(value) => set("taxId", value)} />
      <SelectField label="Tax ID type" value={provider.taxIdType ?? "E"} options={[{ value: "E", label: "EIN" }, { value: "S", label: "SSN" }]} onChange={(value) => set("taxIdType", value)} />
      <Field label="Taxonomy" value={provider.taxonomy ?? ""} onChange={(value) => set("taxonomy", value)} />
      <Field label="Address" value={provider.address1 ?? ""} onChange={(value) => set("address1", value)} />
      <Field label="City" value={provider.city ?? ""} onChange={(value) => set("city", value)} />
      <Field label="State" value={provider.state ?? ""} onChange={(value) => set("state", value)} />
      <Field label="ZIP" value={provider.zip ?? ""} onChange={(value) => set("zip", value)} />
      <Field label="Phone" value={provider.phone ?? ""} onChange={(value) => set("phone", value)} />
    </div>
  );
}

export function PersonFields({ person, onChange, includePolicy = false }: { person: ClaimMdPersonInput; onChange: (person: ClaimMdPersonInput) => void; includePolicy?: boolean }) {
  const set = (key: keyof ClaimMdPersonInput, value: string) => onChange({ ...person, [key]: value });
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      <Field label="First name" value={person.firstName} onChange={(value) => set("firstName", value)} />
      <Field label="Middle name" value={person.middleName ?? ""} onChange={(value) => set("middleName", value)} />
      <Field label="Last name" value={person.lastName} onChange={(value) => set("lastName", value)} />
      <Field label="Date of birth" type="date" value={person.dateOfBirth} onChange={(value) => set("dateOfBirth", value)} />
      <SelectField label="Sex" value={person.sex} options={[{ value: "M", label: "Male" }, { value: "F", label: "Female" }, { value: "U", label: "Unknown/other" }]} onChange={(value) => set("sex", value)} />
      <Field label="Address" value={person.address1 ?? ""} onChange={(value) => set("address1", value)} />
      <Field label="City" value={person.city ?? ""} onChange={(value) => set("city", value)} />
      <Field label="State" value={person.state ?? ""} onChange={(value) => set("state", value)} />
      <Field label="ZIP" value={person.zip ?? ""} onChange={(value) => set("zip", value)} />
      {includePolicy && <Field label="Member ID" value={person.memberId ?? ""} onChange={(value) => set("memberId", value)} />}
      {includePolicy && <Field label="Group number" value={person.groupNumber ?? ""} onChange={(value) => set("groupNumber", value)} />}
      {includePolicy && <Field label="Subscriber relationship code" value={person.relationshipCode ?? ""} onChange={(value) => set("relationshipCode", value)} />}
    </div>
  );
}

function PersonSummary({ person }: { person: ClaimMdPersonInput }) {
  return (
    <dl className="grid gap-3 text-sm md:grid-cols-3">
      <Detail label="Name" value={[person.firstName, person.middleName, person.lastName].filter(Boolean).join(" ") || "Missing"} />
      <Detail label="DOB / sex" value={`${person.dateOfBirth || "Missing"} · ${person.sex}`} />
      <Detail label="Member / group" value={`${person.memberId ?? "Missing"} · ${person.groupNumber ?? "Missing"}`} />
    </dl>
  );
}

function DiagnosisLines({ lines, onChange }: { lines: DiagnosisLine[]; onChange: (lines: DiagnosisLine[]) => void }) {
  const update = (index: number, value: DiagnosisLine) => onChange(lines.map((line, candidate) => candidate === index ? value : line));
  return (
    <div className="space-y-3">
      {lines.map((line, index) => (
        <div key={index} className="grid gap-2 md:grid-cols-[4rem_1fr_2fr_auto] md:items-end">
          <ReadOnlyField label="Line" value={String(index + 1)} />
          <Field label="ICD-10 code" value={line.code} onChange={(code) => update(index, { ...line, code })} />
          <Field label="Description" value={line.description} onChange={(description) => update(index, { ...line, description })} />
          <button type="button" disabled={lines.length === 1} onClick={() => onChange(removeDiagnosisLine(lines, index))} className="rounded border border-white/15 px-3 py-2 text-sm text-white/60 disabled:opacity-30">Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange(addDiagnosisLine(lines))} className="rounded border border-blue-400/30 px-3 py-2 text-sm text-blue-200">Add diagnosis</button>
    </div>
  );
}

function ChargeLines({ lines, onChange }: { lines: ChargeLine[]; onChange: (lines: ChargeLine[]) => void }) {
  const update = (index: number, value: ChargeLine) => onChange(lines.map((line, candidate) => candidate === index ? value : line));
  return (
    <div className="space-y-3">
      {lines.map((line, index) => (
        <div key={index} className="grid gap-2 md:grid-cols-[8rem_1fr_2fr_8rem_6rem_auto] md:items-end">
          <SelectField label="Code set" value={line.codeType} options={[{ value: "CPT", label: "CPT" }, { value: "HCPCS", label: "HCPCS" }]} onChange={(codeType) => update(index, { ...line, codeType: codeType as "CPT" | "HCPCS" })} />
          <Field label="Code" value={line.code} onChange={(code) => update(index, { ...line, code })} />
          <Field label="Description" value={line.description} onChange={(description) => update(index, { ...line, description })} />
          <Field label="Fee (USD)" value={line.feeDollars} placeholder="125.50" onChange={(feeDollars) => update(index, { ...line, feeDollars })} />
          <Field label="Quantity" type="number" value={line.quantity} onChange={(quantity) => update(index, { ...line, quantity })} />
          <button type="button" disabled={lines.length === 1} onClick={() => onChange(removeChargeLine(lines, index))} className="rounded border border-white/15 px-3 py-2 text-sm text-white/60 disabled:opacity-30">Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange(addChargeLine(lines))} className="rounded border border-blue-400/30 px-3 py-2 text-sm text-blue-200">Add charge</button>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-white/40">{label}</dt><dd className="mt-1 break-all font-semibold text-white/75">{value}</dd></div>;
}

function emptyCoverageEntry(today: string, patientReference = ""): CoverageEntryInput {
  return { patientReference, payorReference: "", payorDisplay: "", memberId: "", groupNumber: "", relationship: "self", effectiveDate: today };
}

function validateCoverageEntry(entry: CoverageEntryInput): string[] {
  const errors: string[] = [];
  if (!entry.patientReference) errors.push("Select a patient before creating Coverage.");
  if (!/^Organization\/[^/]+$/.test(entry.payorReference.trim())) errors.push("Payor must be an Organization reference such as Organization/123.");
  if (!entry.memberId.trim()) errors.push("Member ID is required.");
  if (!entry.groupNumber.trim()) errors.push("Group number is required.");
  if (!entry.effectiveDate) errors.push("Effective date is required.");
  return errors;
}

function claimApiBaseUrl(): string {
  const meta = import.meta as ImportMeta & { env?: { VITE_OSOD_MCP_BASE_URL?: string } };
  return meta.env?.VITE_OSOD_MCP_BASE_URL?.replace(/\/$/, "") ?? "";
}
