import { useState } from "react";
import type { Patient } from "@medplum/fhirtypes";
import { PatientDemographicsFields } from "../components/patient/PatientDemographicsEditor";
import {
  createPatient,
  emptyPatientDemographics,
  localCalendarDate,
  registerPatient,
  validatePatientRegistration,
  type PatientDemographicsDraft,
} from "../lib/patient-registration";
import {
  emptyRelatedResponsibleParty,
  emptySelfResponsibleParty,
  type ResponsiblePartyDraft,
  type ResponsiblePartyRelationship,
} from "../lib/patient-identity";
import { patientName } from "../lib/scheduler-appointment-ui";
import { openPatientOverview, useViewState } from "../lib/view-state";

export function NewPatient() {
  const setView = useViewState((state) => state.setView);
  const today = localCalendarDate();
  const [draft, setDraft] = useState<PatientDemographicsDraft>(() => emptyPatientDemographics());
  const [responsibleParties, setResponsibleParties] = useState<ResponsiblePartyDraft[]>(() => [
    emptySelfResponsibleParty("self"),
  ]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [duplicates, setDuplicates] = useState<Patient[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [repairWarning, setRepairWarning] = useState<{ message: string }>();

  const openPatient = (patient: Patient) => {
    if (patient.id) {
      openPatientOverview(patient.id, "replace");
    }
  };

  const returnToSearch = () => {
    window.history.replaceState({}, "", "/");
    setView({ kind: "picker" });
  };

  const submit = async () => {
    const registrationOptions = { responsibleParties, today };
    const nextErrors = validatePatientRegistration(draft, registrationOptions);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await registerPatient(draft, registrationOptions);
      if (result.kind === "duplicates") {
        setDuplicates(result.patients);
      } else if (result.warning) {
        setRepairWarning({ message: result.warning.message });
      } else {
        openPatient(result.patient);
      }
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const createAnyway = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await createPatient(draft, { responsibleParties, today });
      if (result.warning) {
        setDuplicates([]);
        setRepairWarning({ message: result.warning.message });
      } else {
        openPatient(result.patient);
      }
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (repairWarning) {
    return <RegistrationRepairNotice warning={repairWarning} onBack={returnToSearch} />;
  }

  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <section className="mx-auto max-w-5xl">
        <header className="mb-6 flex items-end justify-between gap-4 border-b border-white/10 pb-5">
          <div><p className="text-xs uppercase tracking-widest text-white/40">Front desk</p><h1 className="mt-1 text-2xl font-semibold">New patient</h1></div>
          <button type="button" onClick={returnToSearch} className="rounded border border-white/15 px-3 py-2 text-sm text-white/65">Back to patient search</button>
        </header>
        {saveError && <div role="alert" className="mb-4 rounded border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{saveError}</div>}
        <PatientDemographicsFields draft={draft} errors={errors} onChange={(next) => { setDraft(next); setDuplicates([]); }} />
        <ResponsiblePartiesEditor
          parties={responsibleParties}
          errors={errors}
          today={today}
          onChange={(next) => {
            setResponsibleParties(next);
            setDuplicates([]);
            setErrors(withoutResponsiblePartyErrors);
          }}
        />
        <div className="mt-6 flex justify-end">
          <button type="button" disabled={saving} onClick={() => void submit()} className="rounded bg-blue-500 px-5 py-2.5 text-sm font-semibold disabled:opacity-50">{saving ? "Checking…" : "Create patient"}</button>
        </div>
      </section>

      {duplicates.length > 0 && <DuplicatePatientWarning patients={duplicates} saving={saving} onUseExisting={openPatient} onBack={() => setDuplicates([])} onCreateAnyway={() => void createAnyway()} />}
    </main>
  );
}

export function RegistrationRepairNotice({
  warning,
  onBack,
}: {
  warning: { message: string };
  onBack: () => void;
}) {
  return (
    <main className="min-h-screen bg-bg-deep p-5 text-[color:var(--odos-text)]">
      <section className="mx-auto max-w-xl rounded border border-[color:var(--odos-accent-border)] bg-bg-panel p-6">
        <p className="text-xs uppercase tracking-widest text-[color:var(--odos-muted)]">Registration complete</p>
        <h1 className="mt-2 text-2xl font-semibold">Patient registered</h1>
        <p role="alert" className="mt-4 text-sm text-[color:var(--odos-text)]">
          {warning.message}
        </p>
        <button
          type="button"
          onClick={onBack}
          className="mt-6 rounded border border-[color:var(--odos-line-2)] px-4 py-2 text-sm text-[color:var(--odos-muted)]"
        >
          Back to patient search
        </button>
      </section>
    </main>
  );
}

export function DuplicatePatientWarning({
  patients,
  saving,
  onUseExisting,
  onBack,
  onCreateAnyway,
}: {
  patients: readonly Patient[];
  saving: boolean;
  onUseExisting: (patient: Patient) => void;
  onBack: () => void;
  onCreateAnyway: () => void;
}) {
  return <div className="fixed inset-0 z-50 overflow-y-auto bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="duplicate-title">
    <section className="mx-auto mt-16 max-w-2xl rounded-xl border border-amber-300/30 bg-bg-panel p-5 shadow-2xl">
      <h2 id="duplicate-title" className="text-xl font-semibold text-amber-100">Possible duplicate patient</h2>
      <p className="mt-2 text-sm text-white/60">An exact legal name and date-of-birth match already exists. Use the existing record unless these are different people.</p>
      <div className="mt-4 grid gap-3">
        {patients.map((patient) => <div key={patient.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-white/10 bg-black/20 p-4"><div><strong>{patientName(patient)}</strong><div className="mt-1 text-sm text-white/45">DOB {patient.birthDate} · ID {patient.id}</div></div><button type="button" onClick={() => onUseExisting(patient)} className="rounded bg-blue-500 px-4 py-2 text-sm font-semibold">Use existing patient</button></div>)}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onBack} className="rounded border border-white/15 px-4 py-2 text-sm">Go back</button>
        <button type="button" disabled={saving} onClick={onCreateAnyway} className="rounded border border-amber-300/40 px-4 py-2 text-sm font-semibold text-amber-100">Create anyway</button>
      </div>
    </section>
  </div>;
}

function ResponsiblePartiesEditor({
  parties,
  errors,
  today,
  onChange,
}: {
  parties: readonly ResponsiblePartyDraft[];
  errors: Record<string, string>;
  today: string;
  onChange: (parties: ResponsiblePartyDraft[]) => void;
}) {
  const update = (index: number, patch: Partial<ResponsiblePartyDraft>) => {
    onChange(parties.map((party, partyIndex) => partyIndex === index ? { ...party, ...patch } : party));
  };
  const remove = (index: number) => onChange(parties.filter((_, partyIndex) => partyIndex !== index));
  return (
    <fieldset className="mt-6 grid gap-4 rounded-lg border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)] p-4">
      <legend className="px-2 text-sm font-semibold text-blue-200">Responsible parties</legend>
      <p className="text-sm text-[color:var(--odos-muted)]">Financial responsibility, consent authority, and insurance subscriber status are separate roles. Insurance subscriber linkage stays in Coverage.</p>
      {errors.responsibleParties && <div role="alert" className="rounded border border-red-400/40 bg-red-950/40 px-3 py-2 text-sm text-red-200">{errors.responsibleParties}</div>}
      {parties.map((party, index) => (
        <section key={party.localId} className="grid gap-4 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <strong>{party.kind === "self" ? "Patient (self)" : `Related person ${index + 1}`}</strong>
            <button type="button" onClick={() => remove(index)} className="rounded border border-[color:var(--odos-line-2)] px-3 py-1.5 text-sm text-[color:var(--odos-muted)]">Remove</button>
          </div>
          {party.kind === "person" && <>
            <div className="grid gap-4 md:grid-cols-3">
              <ResponsibleInput label="First name" value={party.firstName} error={partyError(errors, index, "firstName")} onChange={(value) => update(index, { firstName: value })} />
              <ResponsibleInput label="Middle name" value={party.middleName} onChange={(value) => update(index, { middleName: value })} />
              <ResponsibleInput label="Last name" value={party.lastName} error={partyError(errors, index, "lastName")} onChange={(value) => update(index, { lastName: value })} />
              <label className="grid gap-1 text-sm font-medium text-[color:var(--odos-muted)]">Relationship<select className="scheduler-input" value={party.relationship} onChange={(event) => update(index, { relationship: event.target.value as ResponsiblePartyRelationship })}>
                <option value="parent">Parent</option>
                <option value="legal-guardian">Legal guardian</option>
                <option value="spouse">Spouse</option>
                <option value="other">Other</option>
              </select></label>
              <ResponsibleInput label="Phone" value={party.phone} onChange={(value) => update(index, { phone: value })} />
              <ResponsibleInput label="Mailing address" value={party.address} error={partyError(errors, index, "address")} onChange={(value) => update(index, { address: value })} />
              <ResponsibleInput label="City" value={party.city} error={partyError(errors, index, "city")} onChange={(value) => update(index, { city: value })} />
              <ResponsibleInput label="State" value={party.state} error={partyError(errors, index, "state")} onChange={(value) => update(index, { state: value })} />
              <ResponsibleInput label="ZIP / postal code" value={party.postalCode} error={partyError(errors, index, "postalCode")} onChange={(value) => update(index, { postalCode: value })} />
              <ResponsibleInput label="Effective date" type="date" value={party.effectiveDate} error={partyError(errors, index, "effectiveDate")} onChange={(value) => update(index, { effectiveDate: value })} />
              <ResponsibleInput label="End date" type="date" value={party.endDate} error={partyError(errors, index, "endDate")} onChange={(value) => update(index, { endDate: value })} />
            </div>
            <label className="grid gap-1 text-sm font-medium text-[color:var(--odos-muted)]">Court order / custody notes<textarea className="scheduler-input min-h-24" value={party.courtOrderNotes} onChange={(event) => update(index, { courtOrderNotes: event.target.value })} /></label>
          </>}
          <div className="flex flex-wrap gap-5 text-sm text-[color:var(--odos-muted)]">
            <ResponsibleCheckbox label="Financially responsible" checked={party.financialResponsible} onChange={(checked) => update(index, { financialResponsible: checked })} />
            {party.kind === "person" && <>
              <ResponsibleCheckbox label="Consent authority" checked={party.consentAuthority} onChange={(checked) => update(index, { consentAuthority: checked })} />
              <ResponsibleCheckbox label="Primary related person" checked={party.primary} onChange={(checked) => update(index, { primary: checked })} />
            </>}
          </div>
        </section>
      ))}
      <div className="flex flex-wrap gap-2">
        {!parties.some((party) => party.kind === "self") && <button type="button" onClick={() => onChange([...parties, emptySelfResponsibleParty("self")])} className="rounded border border-[color:var(--odos-line-2)] px-3 py-2 text-sm">Add patient as self</button>}
        <button type="button" onClick={() => onChange([...parties, emptyRelatedResponsibleParty(crypto.randomUUID(), today)])} className="rounded border border-blue-300/30 px-3 py-2 text-sm text-blue-100">Add related person</button>
      </div>
    </fieldset>
  );
}

function ResponsibleInput({
  label,
  type = "text",
  value,
  error,
  onChange,
}: {
  label: string;
  type?: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  return <label className="grid gap-1 text-sm font-medium text-[color:var(--odos-muted)]">{label}<input className="scheduler-input" type={type} value={value} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />{error && <span className="text-sm text-red-200">{error}</span>}</label>;
}

function ResponsibleCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function partyError(errors: Record<string, string>, index: number, field: string): string | undefined {
  return errors[`responsibleParties.${index}.${field}`];
}

export function withoutResponsiblePartyErrors(
  errors: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).filter(([key]) =>
      key !== "responsibleParties" && !key.startsWith("responsibleParties.")),
  );
}
