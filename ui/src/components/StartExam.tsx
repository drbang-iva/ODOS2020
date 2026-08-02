import { useEffect, useState } from "react";
import type { Bundle, EpisodeOfCare, Patient } from "@medplum/fhirtypes";
import {
  assertTransactionSuccess,
  buildEncounterStatusPatchBundle,
  buildStartEncounterCreateBundle,
  createdIdFromEntry,
} from "../lib/encounter-bundles";
import { createProgram } from "../lib/clinical-actions";
import { clinicalGraphApiBase } from "../lib/clinical-graph-client";
import { episodeTypeLabel } from "../lib/clinical-view-model";
import { fhir } from "../lib/fhir";
import {
  EPISODE_OF_CARE_TYPE_CODES,
  type EpisodeOfCareTypeCode,
} from "../lib/fhir-clinical/episodeOfCare";
import { useViewState } from "../lib/view-state";
import { OdosSelect } from "./inputs/OdosSelect";

export interface StartExamApi {
  loadPrograms: (patientId: string) => Promise<EpisodeOfCare[]>;
  assignProvider: (patientId: string) => Promise<void>;
  createProgram: typeof createProgram;
  executeTransaction: (bundle: Bundle, sourceTag: string) => Promise<Bundle>;
  now: () => Date;
}

const defaultStartExamApi: StartExamApi = {
  async loadPrograms(patientId) {
    const bundle = await fhir.search<EpisodeOfCare>("EpisodeOfCare", {
      patient: `Patient/${patientId}`,
      _count: "20",
    });
    return (bundle.entry ?? [])
      .flatMap((entry) => (entry.resource ? [entry.resource] : []))
      .filter((episode) => episode.status === "active");
  },
  async assignProvider(patientId) {
    const response = await fetch(
      `${clinicalGraphApiBase()}/clinical-graph/patients/${encodeURIComponent(patientId)}/assign-provider`,
      {
        method: "POST",
        headers: {
          Authorization: fhir.authHeader() ?? "",
          "Content-Type": "application/json",
        },
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Provider assignment failed (${response.status}).`);
    }
  },
  createProgram,
  executeTransaction: (bundle, sourceTag) => fhir.executeTransaction(bundle, sourceTag),
  now: () => new Date(),
};

export function StartExam({
  patient,
  api = defaultStartExamApi,
}: {
  patient: Patient;
  api?: StartExamApi;
}) {
  const setView = useViewState((state) => state.setView);
  const [startMode, setStartMode] = useState<"standalone" | "existing" | "new">("standalone");
  const [programType, setProgramType] = useState<EpisodeOfCareTypeCode>("glaucoma");
  const [selectedProgramId, setSelectedProgramId] = useState("");
  const [programs, setPrograms] = useState<EpisodeOfCare[]>([]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadPrograms() {
      if (startMode !== "existing" || !patient.id) return;
      const active = await api.loadPrograms(patient.id);
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
  }, [api, patient.id, startMode]);

  async function startExam() {
    if (!patient.id || starting) return;

    setStarting(true);
    setStartError(null);
    try {
      const now = api.now();
      await assignProvider(patient.id);
      const episodeReference = await resolveProgramReference();
      const createResponse = await api.executeTransaction(
        buildStartEncounterCreateBundle({
          patientId: patient.id,
          now: now.toISOString(),
          episodeReference,
        }),
        "start_encounter",
      );
      assertTransactionSuccess(createResponse);

      const encounterId = createdIdFromEntry(createResponse, 0, "Encounter");
      const inProgressResponse = await api.executeTransaction(
        buildEncounterStatusPatchBundle({
          encounterId,
          patientId: patient.id,
          recorded: new Date(now.getTime() + 1).toISOString(),
          operatorDisplay: "ODOS UI start_encounter",
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

  async function assignProvider(patientId: string): Promise<void> {
    await api.assignProvider(patientId);
  }

  async function resolveProgramReference(): Promise<string | undefined> {
    if (!patient.id || startMode === "standalone") return undefined;
    if (startMode === "existing") {
      if (!selectedProgramId) {
        throw new Error("Choose an active program or start this as a stand-alone visit.");
      }
      return `EpisodeOfCare/${selectedProgramId}`;
    }

    const created = await api.createProgram({
      patientReference: `Patient/${patient.id}`,
      typeCode: programType,
    });
    return `EpisodeOfCare/${created.id}`;
  }

  return (
    <div data-testid="start-exam-prompt" className="odos-start-exam">
      <div className="odos-start-exam-title">Start comprehensive exam</div>
      <div className="odos-start-exam-modes">
        <StartModeButton active={startMode === "standalone"} onClick={() => setStartMode("standalone")}>Stand-alone visit</StartModeButton>
        <StartModeButton active={startMode === "existing"} onClick={() => setStartMode("existing")}>Part of an existing program</StartModeButton>
        <StartModeButton active={startMode === "new"} onClick={() => setStartMode("new")}>Start a new program</StartModeButton>
      </div>

      {startMode === "existing" && (
        <div className="odos-start-exam-select">
          <OdosSelect
            value={selectedProgramId}
            options={programs.length === 0
              ? [{ value: "", label: "No active programs" }]
              : programs.map((program) => ({
                  value: program.id ?? "",
                  label: `${episodeTypeLabel(program)} · ${program.status}`,
                }))}
            onChange={setSelectedProgramId}
            ariaLabel="Existing program"
          />
        </div>
      )}

      {startMode === "new" && (
        <div className="odos-start-exam-select">
          <OdosSelect
            value={programType}
            options={EPISODE_OF_CARE_TYPE_CODES.map((code) => ({ value: code, label: programTypeLabel(code) }))}
            onChange={setProgramType}
            ariaLabel="New program type"
          />
        </div>
      )}

      {startError && <p className="odos-overview-error" role="alert">{startError}</p>}
      <button
        type="button"
        disabled={!patient.id || starting}
        onClick={() => void startExam()}
        className="odos-overview-button is-primary odos-start-exam-submit"
      >
        {starting ? "Starting visit…" : "Start today's visit →"}
      </button>
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
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`odos-start-exam-mode${active ? " is-active" : ""}`}
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
