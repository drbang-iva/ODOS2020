import { useEffect, useState } from "react";
import { PatientDirector } from "./scenes/PatientDirector";
import { fhir } from "./lib/fhir";
import type { Patient } from "@medplum/fhirtypes";

export function App() {
  const [authed, setAuthed] = useState(false);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        const bundle = await fhir.search<Patient>("Patient", { _count: "1" });
        const first = bundle.entry?.[0]?.resource;
        if (first) setPatient(first);
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

  if (!authed || !patient) {
    return (
      <div className="h-screen grid place-items-center">
        <div className="text-white/60">Connecting to FHIR…</div>
      </div>
    );
  }

  return <PatientDirector patient={patient} />;
}
