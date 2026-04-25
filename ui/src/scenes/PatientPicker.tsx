import { useEffect, useMemo, useState } from "react";
import type { Patient } from "@medplum/fhirtypes";
import { fhir } from "../lib/fhir";
import { useViewState } from "../lib/view-state";

export function PatientPicker() {
  const setView = useViewState((state) => state.setView);
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      async function searchPatients() {
        setLoading(true);
        setError(null);
        try {
          const trimmed = query.trim();
          const bundle = await fhir.search<Patient>(
            "Patient",
            trimmed ? { name: trimmed, _count: "50" } : { _count: "50" },
          );
          if (!cancelled) {
            setPatients((bundle.entry ?? []).flatMap((entry) => (entry.resource ? [entry.resource] : [])));
          }
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setPatients([]);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      }

      void searchPatients();
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query]);

  const statusText = useMemo(() => {
    if (loading) return "Searching";
    if (patients.length === 1) return "1 patient";
    return `${patients.length} patients`;
  }, [loading, patients.length]);

  return (
    <div className="min-h-screen bg-bg text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-8">
        <header className="flex items-center justify-between border-b border-white/10 pb-5">
          <div>
            <div className="text-xs uppercase tracking-widest text-white/40">OSOD</div>
            <h1 className="mt-1 text-2xl font-semibold">Patient Picker</h1>
          </div>
          <div className="rounded border border-white/10 px-3 py-1 text-xs text-white/50">
            v0.3 clinical entry
          </div>
        </header>

        <main className="flex-1 py-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <label className="block w-full max-w-xl">
              <span className="text-sm text-white/60">Search patients</span>
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name"
                className="mt-2 h-12 w-full rounded border border-white/15 bg-bg-panel px-4 text-base text-white outline-none transition focus:border-brand"
              />
            </label>
            <div className="text-sm text-white/45">{statusText}</div>
          </div>

          {error && (
            <div className="mt-6 rounded border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-100">
              {error}
            </div>
          )}

          <div className="mt-6 grid gap-3">
            {loading && (
              <div className="rounded border border-white/10 bg-bg-panel p-5 text-sm text-white/50">
                Loading patients…
              </div>
            )}

            {!loading && !error && patients.length === 0 && (
              <div className="rounded border border-white/10 bg-bg-panel p-5 text-sm text-white/50">
                No patients found.
              </div>
            )}

            {!loading && patients.map((patient) => (
              <button
                key={patient.id}
                disabled={!patient.id}
                onClick={() => patient.id && setView({ kind: "director", patientId: patient.id })}
                className="group grid min-h-24 grid-cols-[1fr_auto] items-center gap-4 rounded border border-white/10 bg-bg-panel p-5 text-left transition hover:border-brand/60 hover:bg-bg-mid disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>
                  <span className="block text-lg font-semibold text-white">{patientName(patient)}</span>
                  <span className="mt-2 flex flex-wrap gap-3 text-sm text-white/45">
                    <span>DOB {patient.birthDate ?? "unknown"}</span>
                    <span>ID {shortId(patient.id)}</span>
                  </span>
                </span>
                <span className="text-sm text-white/35 transition group-hover:text-brand">Open</span>
              </button>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}

function patientName(patient: Patient): string {
  const name = patient.name?.[0];
  if (!name) return "Unknown patient";
  return `${name.given?.join(" ") ?? ""} ${name.family ?? ""}`.trim() || "Unknown patient";
}

function shortId(id: string | undefined): string {
  if (!id) return "pending";
  return id.length <= 8 ? id : id.slice(0, 8);
}
