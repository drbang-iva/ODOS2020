import { useState } from "react";
import type { Patient } from "@medplum/fhirtypes";
import { PatientDemographicsFields } from "../components/patient/PatientDemographicsEditor";
import {
  createPatient,
  emptyPatientDemographics,
  registerPatient,
  validatePatientDemographics,
  type PatientDemographicsDraft,
} from "../lib/patient-registration";
import { patientName } from "../lib/scheduler-appointment-ui";
import { openPatientOverview, useViewState } from "../lib/view-state";

export function NewPatient() {
  const setView = useViewState((state) => state.setView);
  const [draft, setDraft] = useState<PatientDemographicsDraft>(() => emptyPatientDemographics());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [duplicates, setDuplicates] = useState<Patient[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

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
    const nextErrors = validatePatientDemographics(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await registerPatient(draft);
      if (result.kind === "duplicates") {
        setDuplicates(result.patients);
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
      openPatient(await createPatient(draft));
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <section className="mx-auto max-w-5xl">
        <header className="mb-6 flex items-end justify-between gap-4 border-b border-white/10 pb-5">
          <div><p className="text-xs uppercase tracking-widest text-white/40">Front desk</p><h1 className="mt-1 text-2xl font-semibold">New patient</h1></div>
          <button type="button" onClick={returnToSearch} className="rounded border border-white/15 px-3 py-2 text-sm text-white/65">Back to patient search</button>
        </header>
        {saveError && <div role="alert" className="mb-4 rounded border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{saveError}</div>}
        <PatientDemographicsFields draft={draft} errors={errors} onChange={(next) => { setDraft(next); setDuplicates([]); }} />
        <div className="mt-6 flex justify-end">
          <button type="button" disabled={saving} onClick={() => void submit()} className="rounded bg-blue-500 px-5 py-2.5 text-sm font-semibold disabled:opacity-50">{saving ? "Checking…" : "Create patient"}</button>
        </div>
      </section>

      {duplicates.length > 0 && <DuplicatePatientWarning patients={duplicates} saving={saving} onUseExisting={openPatient} onBack={() => setDuplicates([])} onCreateAnyway={() => void createAnyway()} />}
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
