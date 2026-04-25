import { useEffect, useState } from "react";
import { PatientDirector } from "./scenes/PatientDirector";
import { PatientPicker } from "./scenes/PatientPicker";
import { fhir } from "./lib/fhir";
import { useViewState, type ViewState } from "./lib/view-state";
import type { Patient } from "@medplum/fhirtypes";

export function App() {
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = useViewState((state) => state.view);

  useEffect(() => {
    async function boot() {
      const email = import.meta.env.VITE_MEDPLUM_ADMIN_EMAIL;
      const password = import.meta.env.VITE_MEDPLUM_ADMIN_PASSWORD;
      if (!email || !password) {
        setError(
          "Missing VITE_MEDPLUM_ADMIN_EMAIL / VITE_MEDPLUM_ADMIN_PASSWORD. " +
            "Copy ui/.env.example to ui/.env and fill in, then restart `npm run dev`.",
        );
        return;
      }
      try {
        await fhir.login(email, password);
        setAuthed(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    boot();
  }, []);

  if (error) {
    return (
      <div className="h-screen grid place-items-center p-8">
        <div className="bg-bg-panel border border-red-500/50 rounded-lg p-6 max-w-xl">
          <h1 className="text-red-400 text-lg font-semibold mb-2">OSOD UI failed to boot</h1>
          <pre className="text-sm text-red-200 whitespace-pre-wrap">{error}</pre>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="h-screen grid place-items-center">
        <div className="text-white/60">Connecting to FHIR…</div>
      </div>
    );
  }

  return <ViewRouter view={view} />;
}

function ViewRouter({ view }: { view: ViewState }) {
  switch (view.kind) {
    case "picker":
      return <PatientPicker />;
    case "director":
      return <PatientRoute patientId={view.patientId} mode="director" />;
    case "encounter":
      return (
        <PatientRoute
          patientId={view.patientId}
          mode="encounter"
          encounterId={view.encounterId}
        />
      );
  }
}

function PatientRoute({
  patientId,
  mode,
  encounterId,
}: {
  patientId: string;
  mode: "director" | "encounter";
  encounterId?: string;
}) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadPatient() {
      setPatient(null);
      setError(null);
      try {
        const loaded = await fhir.read<Patient>("Patient", patientId);
        if (!cancelled) setPatient(loaded);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void loadPatient();
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  if (error) {
    return (
      <div className="h-screen grid place-items-center p-8">
        <div className="bg-bg-panel border border-red-500/50 rounded-lg p-6 max-w-xl">
          <h1 className="text-red-400 text-lg font-semibold mb-2">Unable to load patient</h1>
          <pre className="text-sm text-red-200 whitespace-pre-wrap">{error}</pre>
        </div>
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="h-screen grid place-items-center">
        <div className="text-white/60">Loading patient…</div>
      </div>
    );
  }

  if (mode === "encounter") {
    return (
      <div className="h-screen grid place-items-center p-8">
        <div className="rounded border border-white/10 bg-bg-panel p-6 text-sm text-white/60">
          Encounter charting is loading for {patientName(patient)} · {encounterId}
        </div>
      </div>
    );
  }

  return <PatientDirector patient={patient} />;
}

function patientName(patient: Patient): string {
  const name = patient.name?.[0];
  if (!name) return "Unknown patient";
  return `${name.given?.join(" ") ?? ""} ${name.family ?? ""}`.trim() || "Unknown patient";
}
