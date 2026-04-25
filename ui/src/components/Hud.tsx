import { useState } from "react";
import type { Patient } from "@medplum/fhirtypes";
import { fhir } from "../lib/fhir";
import {
  assertTransactionSuccess,
  buildEncounterStatusPatchBundle,
  buildStartEncounterCreateBundle,
  createdIdFromEntry,
} from "../lib/encounter-bundles";
import { useViewState } from "../lib/view-state";
import type { OrbitalId } from "../types/orbital";
import { ORBITAL_LABELS } from "../types/orbital";

interface Props {
  patient: Patient;
  selected: OrbitalId | null;
  onClearSelection: () => void;
}

export function Hud({ patient, selected, onClearSelection }: Props) {
  const setView = useViewState((state) => state.setView);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const name = patient.name?.[0];
  const display = name
    ? `${name.given?.join(" ") ?? ""} ${name.family ?? ""}`.trim()
    : "Unknown";

  async function startExam() {
    if (!patient.id || starting) {
      return;
    }

    setStarting(true);
    setStartError(null);
    try {
      const now = new Date();
      const createResponse = await fhir.executeTransaction(
        buildStartEncounterCreateBundle({
          patientId: patient.id,
          now: now.toISOString(),
        }),
        "start_encounter",
      );
      assertTransactionSuccess(createResponse);

      const encounterId = createdIdFromEntry(createResponse, 0, "Encounter");
      const inProgressResponse = await fhir.executeTransaction(
        buildEncounterStatusPatchBundle({
          encounterId,
          recorded: new Date(now.getTime() + 1).toISOString(),
          operatorDisplay: "OSOD UI start_encounter",
          ops: [{ op: "replace", path: "/status", value: "in-progress" }],
        }),
        "start_encounter",
      );
      assertTransactionSuccess(inProgressResponse);

      setView({ kind: "encounter", patientId: patient.id, encounterId });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col">
      <header className="pointer-events-auto p-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="text-sm tracking-widest text-white/40 uppercase">OSOD · Patient Director</div>
          <div className="h-4 w-px bg-white/20" />
          <div className="text-sm font-semibold">{display}</div>
          {patient.birthDate && (
            <div className="text-xs text-white/50">DOB {patient.birthDate}</div>
          )}
        </div>
        <div className="text-xs text-white/30">v0.2 — Variant A</div>
      </header>

      <div className="flex-1" />

      {startError && (
        <div className="pointer-events-auto mx-4 mb-3 rounded border border-red-500/40 bg-red-500/15 p-3 text-sm text-red-100">
          {startError}
        </div>
      )}

      <footer className="pointer-events-auto p-4 text-xs text-white/40 flex items-end justify-between gap-4">
        <div className="min-h-9">
          {selected ? (
            <span>
              Focused: <span className="text-white/80">{ORBITAL_LABELS[selected]}</span>{" "}
              <button className="underline hover:text-white" onClick={onClearSelection}>
                clear
              </button>
            </span>
          ) : (
            <button
              disabled={!patient.id || starting}
              onClick={startExam}
              className="rounded border border-brand/50 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:border-brand hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting ? "Starting exam…" : "Start comprehensive exam"}
            </button>
          )}
        </div>
        <div>Drag to rotate · scroll to zoom</div>
      </footer>
    </div>
  );
}
