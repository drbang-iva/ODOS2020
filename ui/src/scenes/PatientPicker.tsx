import type { Patient } from "@medplum/fhirtypes";
import type { Ref } from "react";
import { OdosSearchPicker, type OdosSearchPickerOption } from "../components/inputs/OdosSearchPicker";
import { fhir } from "../lib/fhir";
import {
  EYEFINITY_EHR_PATIENT_ID_SYSTEM,
  EYEFINITY_EPM_PATIENT_ID_SYSTEM,
  ODOS_MRN_SYSTEM,
  patientOdosMrn,
} from "../lib/patient-identity";
import { patientName } from "../lib/scheduler-appointment-ui";
import { openPatientOverview } from "../lib/view-state";

export function PatientPicker() {
  return (
    <div className="min-h-screen bg-bg-deep text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-8">
        <header className="flex items-center justify-between border-b border-white/10 pb-5">
          <div>
            <div className="text-xs uppercase tracking-widest text-white/40">ODOS</div>
            <h1 className="mt-1 text-2xl font-semibold">Patient Picker</h1>
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => window.location.assign("/patient/new")} className="rounded bg-blue-500 px-4 py-2 text-sm font-semibold text-white">
              + New Patient
            </button>
            <div className="rounded border border-white/10 px-3 py-1 text-xs text-white/50">
              v0.3 clinical entry
            </div>
          </div>
        </header>

        <main className="flex-1 py-8">
          <PatientSearch
            autoFocus
            actionLabel="Open"
            onSelect={(patient) => patient.id && openPatientOverview(patient.id)}
          />
        </main>
      </div>
    </div>
  );
}

export function PatientSearch({
  onSelect,
  actionLabel = "Select",
  autoFocus = false,
  search = searchPatients,
  label = "Search patients",
  placeholder = "Name",
  inputRef,
}: {
  onSelect: (patient: Patient) => void;
  actionLabel?: string;
  autoFocus?: boolean;
  search?: (query: string) => Promise<Patient[]>;
  label?: string;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <OdosSearchPicker
      label={label}
      value=""
      placeholder={placeholder}
      autoFocus={autoFocus}
      inputRef={inputRef}
      searchDelayMs={300}
      search={async (query) => (await search(query)).flatMap(
        (patient) => patientPickerOption(patient, actionLabel, query),
      )}
      onClear={() => undefined}
      onSelect={(option) => onSelect(option.item)}
    />
  );
}

export async function searchPatients(
  query: string,
  api: Pick<typeof fhir, "search"> = fhir,
): Promise<Patient[]> {
  const normalized = query.trim();
  const bundles = /^\d+$/.test(normalized)
    ? await Promise.all([
        api.search<Patient>("Patient", { identifier: `${ODOS_MRN_SYSTEM}|${normalized}`, _count: "50" }),
        api.search<Patient>("Patient", { identifier: `${EYEFINITY_EHR_PATIENT_ID_SYSTEM}|${normalized}`, _count: "50" }),
        api.search<Patient>("Patient", { identifier: `${EYEFINITY_EPM_PATIENT_ID_SYSTEM}|${normalized}`, _count: "50" }),
      ])
    : [await api.search<Patient>("Patient", { name: normalized, _count: "50" })];
  const seen = new Set<string>();
  return bundles
    .flatMap((bundle) => bundle.entry ?? [])
    .flatMap((entry) => entry.resource ? [entry.resource] : [])
    .filter((patient) => {
      const key = patient.id ?? JSON.stringify(patient.identifier ?? []);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function patientPickerOption(
  patient: Patient,
  actionLabel: string,
  query: string,
): OdosSearchPickerOption<Patient>[] {
  if (!patient.id) return [];
  const matchedIdentifier = identifierMatchDescription(patient, query.trim());
  const mrn = patientOdosMrn(patient);
  return [{
    value: `Patient/${patient.id}`,
    label: patientName(patient),
    description: [
      `DOB ${patient.birthDate ?? "unknown"}`,
      matchedIdentifier,
      !matchedIdentifier && mrn ? `MRN ${mrn}` : undefined,
      !matchedIdentifier && !mrn ? `ID ${shortId(patient.id)}` : undefined,
      actionLabel,
    ].filter(Boolean).join(" · "),
    item: patient,
  }];
}

function identifierMatchDescription(patient: Patient, query: string): string | undefined {
  if (!/^\d+$/.test(query)) return undefined;
  const identifier = patient.identifier?.find((candidate) => candidate.value === query && [
    ODOS_MRN_SYSTEM,
    EYEFINITY_EHR_PATIENT_ID_SYSTEM,
    EYEFINITY_EPM_PATIENT_ID_SYSTEM,
  ].includes(candidate.system ?? ""));
  if (!identifier) return undefined;
  if (identifier.system === ODOS_MRN_SYSTEM) return `Matched ODOS MRN ${query}`;
  if (identifier.system === EYEFINITY_EHR_PATIENT_ID_SYSTEM) return `Matched legacy EHR ID ${query}`;
  return `Matched legacy EPM ID ${query}`;
}

function shortId(id: string | undefined): string {
  if (!id) return "pending";
  return id.length <= 8 ? id : id.slice(0, 8);
}
