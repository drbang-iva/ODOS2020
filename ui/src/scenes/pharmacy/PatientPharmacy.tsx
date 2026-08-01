import { useEffect, useState } from "react";
import type { Patient } from "@medplum/fhirtypes";
import {
  PharmacyDirectoryPicker,
  type PharmacySelection,
} from "../../components/pharmacy/PharmacyDirectoryPicker";
import { fhir } from "../../lib/fhir";
import {
  isStructuredPharmacy,
  pharmacyDisplay,
  pharmacyFromResource,
  withPreferredPharmacy,
  type PreferredPharmacy,
} from "../../lib/fhir-medication-order";
import { patientName } from "../../lib/scheduler-appointment-ui";
import { PatientSearch } from "../PatientPicker";

export function PatientPharmacy({ initialPatientId }: { initialPatientId?: string }) {
  const [patient, setPatient] = useState<Patient>();
  const [preferredPharmacy, setPreferredPharmacy] = useState<PreferredPharmacy>();
  const [draft, setDraft] = useState<PharmacySelection>({ pharmacy: "" });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!initialPatientId) return;
    let cancelled = false;
    setLoading(true);
    void fhir.read<Patient>("Patient", initialPatientId)
      .then((loaded) => { if (!cancelled) applyLoadedPatient(loaded); })
      .catch((cause) => { if (!cancelled) setError(messageOf(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [initialPatientId]);

  const load = async (selected: Patient) => {
    if (!selected.id) return;
    setLoading(true);
    setError(undefined);
    try {
      applyLoadedPatient(await fhir.read<Patient>("Patient", selected.id));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  };

  const selectPatient = (selected: Patient) => {
    if (!selected.id) return;
    setPatient(selected);
    setPreferredPharmacy(undefined);
    setDraft({ pharmacy: "" });
    setDirty(false);
    setSaved(false);
    void load(selected);
  };

  const applyLoadedPatient = (loaded: Patient) => {
    const loadedPharmacy = pharmacyFromResource(loaded);
    setPatient(loaded);
    setPreferredPharmacy(loadedPharmacy);
    setDraft(selectionFromPreferredPharmacy(loadedPharmacy));
    setDirty(false);
    setSaved(false);
    setError(undefined);
  };

  const persist = async (next: PreferredPharmacy | undefined) => {
    if (!patient) return;
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      const updated = await fhir.update<Patient>(
        withPreferredPharmacy(patient, next),
        "update_preferred_pharmacy",
        patient.meta?.versionId,
      );
      applyLoadedPatient(updated);
      setSaved(true);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const next = draft.pharmacyDetails
      ?? (draft.pharmacy.trim() ? { name: draft.pharmacy.trim() } : undefined);
    void persist(next);
  };

  const changePatient = () => {
    setPatient(undefined);
    setPreferredPharmacy(undefined);
    setDraft({ pharmacy: "" });
    setDirty(false);
    setSaved(false);
    setError(undefined);
  };

  return (
    <main className="min-h-screen bg-bg-deep p-5 text-[color:var(--odos-text)]">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--odos-faint)]">Patient chart</p>
          <h1 className="text-2xl font-semibold">Pharmacy</h1>
          <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Set the preferred pharmacy used for new prescriptions.</p>
        </div>
        {patient && (
          <button type="button" onClick={changePatient} className="rounded border border-[color:var(--odos-line-2)] px-3 py-2 text-sm text-[color:var(--odos-muted)]">Change patient</button>
        )}
      </header>

      {error && <div role="alert" className="mb-4 rounded border border-[color:var(--odos-alert)] bg-[color:var(--odos-surface-2)] px-4 py-3 text-sm text-[color:var(--odos-alert)]">{error}</div>}
      {saved && <div role="status" className="mb-4 rounded border border-[color:var(--odos-emerald)] bg-[color:var(--odos-surface-2)] px-4 py-3 text-sm text-[color:var(--odos-emerald)]">Preferred pharmacy saved.</div>}

      {!patient ? (
        <section className="rounded-lg border border-[color:var(--odos-line)] bg-bg-panel/80 p-5">
          <h2 className="text-lg font-semibold">Select a patient</h2>
          <div className="mt-5"><PatientSearch actionLabel="View pharmacy" onSelect={selectPatient} /></div>
        </section>
      ) : (
        <>
          <section className="mb-4 rounded-lg border border-[color:var(--odos-accent-border)] bg-[color:var(--odos-accent-tint-lo)] px-4 py-3">
            <strong>{patientName(patient)}</strong>
            <span className="ml-2 text-xs text-[color:var(--odos-faint)]">Patient/{patient.id}</span>
          </section>
          {loading ? (
            <div className="grid min-h-52 place-items-center text-sm text-[color:var(--odos-muted)]">Loading pharmacy…</div>
          ) : (
            <section className="max-w-3xl rounded-lg border border-[color:var(--odos-line)] bg-bg-panel/80 p-5">
              <div className="mb-5">
                <h2 className="text-lg font-semibold">Preferred pharmacy</h2>
                <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Search the WENO directory or use a pharmacy name as written.</p>
              </div>
              <PharmacyDirectoryPicker
                label="Preferred pharmacy ZIP or city"
                stateLabel="Preferred pharmacy state"
                pharmacy={draft.pharmacy}
                pharmacyNcpdpId={draft.pharmacyNcpdpId}
                allowFreeText
                onChange={(selection) => {
                  setDraft(selection);
                  setDirty(true);
                  setSaved(false);
                }}
              />
              <div className="mt-5 flex flex-wrap gap-3">
                <button type="button" disabled={saving || !dirty} onClick={save} className="rounded bg-[color:var(--odos-accent)] px-4 py-2 text-sm font-semibold text-[color:var(--odos-accent-ink)] disabled:opacity-50">{saving ? "Saving…" : "Save preferred pharmacy"}</button>
                {preferredPharmacy && <button type="button" disabled={saving} onClick={() => void persist(undefined)} className="rounded border border-[color:var(--odos-line-2)] px-4 py-2 text-sm text-[color:var(--odos-muted)] disabled:opacity-50">Clear preferred pharmacy</button>}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function selectionFromPreferredPharmacy(pharmacy: PreferredPharmacy | undefined): PharmacySelection {
  if (!pharmacy) return { pharmacy: "" };
  return {
    pharmacy: pharmacyDisplay(pharmacy),
    ...(isStructuredPharmacy(pharmacy)
      ? { pharmacyNcpdpId: pharmacy.ncpdpId, pharmacyDetails: pharmacy }
      : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
