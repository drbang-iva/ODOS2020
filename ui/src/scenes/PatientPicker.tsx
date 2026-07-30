import type { Patient } from "@medplum/fhirtypes";
import type { Ref } from "react";
import { OdosSearchPicker, type OdosSearchPickerOption } from "../components/inputs/OdosSearchPicker";
import { fhir } from "../lib/fhir";
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
      search={async (query) => (await search(query)).flatMap((patient) => patientPickerOption(patient, actionLabel))}
      onClear={() => undefined}
      onSelect={(option) => onSelect(option.item)}
    />
  );
}

async function searchPatients(query: string): Promise<Patient[]> {
  const bundle = await fhir.search<Patient>("Patient", { name: query, _count: "50" });
  return (bundle.entry ?? []).flatMap((entry) => (entry.resource ? [entry.resource] : []));
}

function patientPickerOption(patient: Patient, actionLabel: string): OdosSearchPickerOption<Patient>[] {
  if (!patient.id) return [];
  return [{
    value: `Patient/${patient.id}`,
    label: patientName(patient),
    description: `DOB ${patient.birthDate ?? "unknown"} · ID ${shortId(patient.id)} · ${actionLabel}`,
    item: patient,
  }];
}

function shortId(id: string | undefined): string {
  if (!id) return "pending";
  return id.length <= 8 ? id : id.slice(0, 8);
}
