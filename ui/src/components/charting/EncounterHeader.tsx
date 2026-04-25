import { useEffect, useMemo, useState } from "react";
import type { Encounter, Patient } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import {
  assertTransactionSuccess,
  buildEncounterStatusPatchBundle,
} from "../../lib/encounter-bundles";
import { useViewState } from "../../lib/view-state";

interface Props {
  patient: Patient;
  encounterId: string;
}

export function EncounterHeader({ patient, encounterId }: Props) {
  const setView = useViewState((state) => state.setView);
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [busy, setBusy] = useState<"finish" | "abandon" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadEncounter() {
      try {
        const loaded = await fhir.read<Encounter>("Encounter", encounterId);
        if (!cancelled) setEncounter(loaded);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void loadEncounter();
    return () => {
      cancelled = true;
    };
  }, [encounterId]);

  const displayName = useMemo(() => patientName(patient), [patient]);

  async function finishEncounter() {
    if (!patient.id || busy) return;
    setBusy("finish");
    setError(null);
    try {
      const now = new Date().toISOString();
      const response = await fhir.executeTransaction(
        buildEncounterStatusPatchBundle({
          encounterId,
          recorded: now,
          operatorDisplay: "OSOD UI finish_encounter",
          ops: [
            { op: "replace", path: "/status", value: "finished" },
            { op: "add", path: "/period/end", value: now },
          ],
        }),
        "finish_encounter",
      );
      assertTransactionSuccess(response);
      setView({ kind: "director", patientId: patient.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function abandonEncounter() {
    if (!patient.id || busy) return;
    setBusy("abandon");
    setError(null);
    try {
      const response = await fhir.executeTransaction(
        buildEncounterStatusPatchBundle({
          encounterId,
          recorded: new Date().toISOString(),
          operatorDisplay: "OSOD UI abandon_encounter",
          ops: [
            { op: "replace", path: "/status", value: "cancelled" },
            {
              op: "add",
              path: "/reasonCode",
              value: [{ text: "abandoned" }],
            },
          ],
        }),
        "abandon_encounter",
      );
      assertTransactionSuccess(response);
      setView({ kind: "director", patientId: patient.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <header className="border-b border-white/10 bg-bg-panel px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-white/35">Comprehensive Exam</div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-white">{displayName}</h1>
            {patient.birthDate && <span className="text-sm text-white/50">DOB {patient.birthDate}</span>}
            <span className="rounded border border-white/10 px-2 py-1 text-xs text-white/60">
              {encounter?.status ?? "loading"}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={abandonEncounter}
            disabled={busy !== null}
            className="rounded border border-white/15 px-3 py-2 text-sm text-white/65 transition hover:border-red-400/60 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "abandon" ? "Abandoning..." : "Abandon encounter"}
          </button>
          <button
            onClick={finishEncounter}
            disabled={busy !== null}
            className="rounded border border-emerald-400/60 bg-emerald-400/15 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "finish" ? "Signing..." : "Sign & finish"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">
          {error}
        </div>
      )}
    </header>
  );
}

function patientName(patient: Patient): string {
  const name = patient.name?.[0];
  if (!name) return "Unknown patient";
  return `${name.given?.join(" ") ?? ""} ${name.family ?? ""}`.trim() || "Unknown patient";
}
