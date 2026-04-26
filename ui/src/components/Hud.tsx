import { useEffect, useState } from "react";
import type { EpisodeOfCare, Patient } from "@medplum/fhirtypes";
import { fhir } from "../lib/fhir";
import { RoleSelector } from "./RoleSelector";
import {
  assertTransactionSuccess,
  buildEncounterStatusPatchBundle,
  buildStartEncounterCreateBundle,
  createdIdFromEntry,
} from "../lib/encounter-bundles";
import { createProgram } from "../lib/clinical-actions";
import {
  EPISODE_OF_CARE_TYPE_CODES,
  type EpisodeOfCareTypeCode,
} from "../lib/fhir-clinical/episodeOfCare";
import { episodeTypeLabel } from "../lib/clinical-view-model";
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
  const [startMode, setStartMode] = useState<"standalone" | "existing" | "new">("standalone");
  const [programType, setProgramType] = useState<EpisodeOfCareTypeCode>("glaucoma");
  const [selectedProgramId, setSelectedProgramId] = useState("");
  const [programs, setPrograms] = useState<EpisodeOfCare[]>([]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const name = patient.name?.[0];
  const display = name
    ? `${name.given?.join(" ") ?? ""} ${name.family ?? ""}`.trim()
    : "Unknown";

  useEffect(() => {
    let cancelled = false;

    async function loadPrograms() {
      if (!patient.id) return;
      const bundle = await fhir.search<EpisodeOfCare>("EpisodeOfCare", {
        patient: `Patient/${patient.id}`,
        _count: "20",
      });
      const active = (bundle.entry ?? [])
        .flatMap((entry) => (entry.resource ? [entry.resource] : []))
        .filter((episode) => episode.status === "active");
      if (!cancelled) {
        setPrograms(active);
        setSelectedProgramId((current) => current || active[0]?.id || "");
      }
    }

    void loadPrograms().catch((err) => {
      if (!cancelled) setStartError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [patient.id]);

  async function startExam() {
    if (!patient.id || starting) {
      return;
    }

    setStarting(true);
    setStartError(null);
    try {
      const now = new Date();
      const episodeReference = await resolveProgramReference();
      const createResponse = await fhir.executeTransaction(
        buildStartEncounterCreateBundle({
          patientId: patient.id,
          now: now.toISOString(),
          episodeReference,
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

  async function resolveProgramReference(): Promise<string | undefined> {
    if (!patient.id || startMode === "standalone") return undefined;
    if (startMode === "existing") {
      if (!selectedProgramId) {
        throw new Error("Choose an active program or start this as a stand-alone visit.");
      }
      return `EpisodeOfCare/${selectedProgramId}`;
    }

    const created = await createProgram({
      patientReference: `Patient/${patient.id}`,
      typeCode: programType,
    });
    return `EpisodeOfCare/${created.id}`;
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
        <div className="flex items-center gap-3">
          <RoleSelector />
          <div className="text-xs text-white/30">v0.35b</div>
        </div>
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
            <div data-testid="start-exam-prompt" className="w-80 rounded border border-white/10 bg-bg-panel/95 p-3 shadow-2xl xl:w-[560px]">
              <div className="text-sm font-semibold text-white">Start comprehensive exam</div>
              <div className="mt-3 grid gap-2 xl:grid-cols-3">
                <StartModeButton active={startMode === "standalone"} onClick={() => setStartMode("standalone")}>
                  Stand-alone visit
                </StartModeButton>
                <StartModeButton active={startMode === "existing"} onClick={() => setStartMode("existing")}>
                  Part of an existing program
                </StartModeButton>
                <StartModeButton active={startMode === "new"} onClick={() => setStartMode("new")}>
                  Start a new program
                </StartModeButton>
              </div>

              {startMode === "existing" && (
                <select value={selectedProgramId} onChange={(event) => setSelectedProgramId(event.target.value)} className="mt-3 h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand">
                  {programs.length === 0 ? (
                    <option value="">No active programs</option>
                  ) : (
                    programs.map((program) => (
                      <option key={program.id} value={program.id}>
                        {episodeTypeLabel(program)} · {program.status}
                      </option>
                    ))
                  )}
                </select>
              )}

              {startMode === "new" && (
                <select value={programType} onChange={(event) => setProgramType(event.target.value as EpisodeOfCareTypeCode)} className="mt-3 h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand">
                  {EPISODE_OF_CARE_TYPE_CODES.map((code) => (
                    <option key={code} value={code}>{programTypeLabel(code)}</option>
                  ))}
                </select>
              )}

              <button
                disabled={!patient.id || starting}
                onClick={startExam}
                className="mt-3 rounded border border-brand/50 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:border-brand hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {starting ? "Starting exam..." : "Start exam"}
              </button>
            </div>
          )}
        </div>
        <div>Drag to rotate · scroll to zoom</div>
      </footer>
    </div>
  );
}

function StartModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "min-h-14 rounded border px-3 py-2 text-left text-xs font-semibold transition",
        active ? "border-brand/70 bg-brand/20 text-white" : "border-white/10 bg-bg-deep text-white/60 hover:border-white/30",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function programTypeLabel(code: EpisodeOfCareTypeCode): string {
  if (code === "myopia-management") return "Myopia management";
  if (code === "glaucoma") return "Glaucoma";
  if (code === "dry-eye") return "Dry eye";
  return "Diabetic eye care";
}
