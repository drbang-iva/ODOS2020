import { useMemo, useState, type ReactNode } from "react";
import type { Patient } from "@medplum/fhirtypes";
import { CatalogFieldKit, type CatalogFieldDescriptor } from "../settings/CatalogFields";
import {
  createPatientDemographicsActions,
  patientDemographicsFromPatient,
  validatePatientDemographics,
  type PatientDemographicsDraft,
} from "../../lib/patient-registration";
import { SmsOptOutControl } from "./SmsOptOutControl";

const GENDER_OPTIONS = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "other", label: "Other" },
  { value: "unknown", label: "Unknown" },
];

const IDENTITY_FIELDS: CatalogFieldDescriptor[] = [
  { key: "firstName", label: "Legal first name", type: "text" },
  { key: "middleName", label: "Middle name", type: "text" },
  { key: "lastName", label: "Legal last name", type: "text" },
  { key: "preferredName", label: "Preferred / alias name", type: "text" },
  { key: "gender", label: "Gender", type: "select", options: GENDER_OPTIONS },
];

const CONTACT_FIELDS: CatalogFieldDescriptor[] = [
  { key: "address", label: "Home address", type: "text" },
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "text" },
  { key: "postalCode", label: "ZIP / postal code", type: "text" },
];

export function PatientDemographicsFields({
  draft,
  errors,
  onChange,
  smsPreferences,
}: {
  draft: PatientDemographicsDraft;
  errors: Record<string, string>;
  onChange: (draft: PatientDemographicsDraft) => void;
  smsPreferences?: ReactNode;
}) {
  const set = (key: string, value: unknown) => onChange({ ...draft, [key]: String(value) });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <fieldset className="grid gap-4 rounded-lg border border-white/10 bg-black/10 p-4">
        <legend className="px-2 text-sm font-semibold text-blue-200">Patient identity</legend>
        <CatalogFieldKit fields={IDENTITY_FIELDS} values={{ ...draft }} errors={errors} onChange={set} />
        <LabeledInput label="Date of birth" type="date" value={draft.birthDate} error={errors.birthDate} onChange={(value) => set("birthDate", value)} />
      </fieldset>
      <fieldset className="grid gap-4 rounded-lg border border-white/10 bg-black/10 p-4">
        <legend className="px-2 text-sm font-semibold text-blue-200">Contact information</legend>
        <LabeledInput label="Phone" type="text" value={draft.phone} error={errors.phone} onChange={(value) => set("phone", value)} />
        {smsPreferences}
        <CatalogFieldKit fields={CONTACT_FIELDS} values={{ ...draft }} errors={errors} onChange={set} />
        <LabeledInput label="Email" type="email" value={draft.email} error={errors.email} onChange={(value) => set("email", value)} />
      </fieldset>
    </div>
  );
}

export function PatientDemographicsEditor({
  patient,
  onSaved,
  onDiscard,
}: {
  patient: Patient;
  onSaved: (patient: Patient) => void;
  onDiscard: () => void;
}) {
  const actions = useMemo(() => createPatientDemographicsActions(patient), [patient]);
  const [draft, setDraft] = useState(() => patientDemographicsFromPatient(patient));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const save = async () => {
    const nextErrors = validatePatientDemographics(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      onSaved(await actions.save(draft));
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(actions.discard());
    onDiscard();
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="demographics-title">
      <section className="mx-auto max-w-5xl rounded-xl border border-white/15 bg-bg-panel p-5 text-white shadow-2xl">
        <div className="mb-5">
          <p className="text-xs uppercase tracking-wide text-white/40">Patient chart</p>
          <h2 id="demographics-title" className="text-xl font-semibold">Edit demographics</h2>
        </div>
        {saveError && <div role="alert" className="mb-4 rounded border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{saveError}</div>}
        <PatientDemographicsFields
          draft={draft}
          errors={errors}
          onChange={setDraft}
          smsPreferences={patient.id ? <SmsOptOutControl patientReference={`Patient/${patient.id}`} /> : undefined}
        />
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={discard} className="rounded border border-white/15 px-4 py-2 text-sm">Discard</button>
          <button type="button" disabled={saving} onClick={() => void save()} className="rounded bg-blue-500 px-4 py-2 text-sm font-semibold disabled:opacity-50">{saving ? "Saving…" : "Save demographics"}</button>
        </div>
      </section>
    </div>
  );
}

function LabeledInput({ label, type, value, error, onChange }: { label: string; type: string; value: string; error?: string; onChange: (value: string) => void }) {
  return <label className="grid gap-1 text-sm font-medium text-white/75">{label}<input className="scheduler-input" type={type} value={value} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />{error && <span className="text-sm text-red-200">{error}</span>}</label>;
}
