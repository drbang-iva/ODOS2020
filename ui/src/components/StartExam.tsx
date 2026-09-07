import { useEffect, useState } from "react";
import type { Bundle, EpisodeOfCare, HealthcareService, Patient } from "@medplum/fhirtypes";
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
import { searchAll } from "../lib/fhir-search";
import {
  EPISODE_OF_CARE_TYPE_CODES,
  type EpisodeOfCareTypeCode,
} from "../lib/fhir-clinical/episodeOfCare";
import { useViewState } from "../lib/view-state";
import {
  ODOS_VISIT_TYPE_SYSTEM,
  visitTypeCode,
} from "../lib/scheduling";
import { OdosSelect } from "./inputs/OdosSelect";

const PROVIDER_ASSIGNMENT_TIMEOUT_MS = 15_000;
export interface StartExamApi {
  loadVisitTypes: () => Promise<HealthcareService[]>;
  loadPrograms: (patientId: string) => Promise<EpisodeOfCare[]>;
  assignProvider: (patientId: string) => Promise<void>;
  createProgram: typeof createProgram;
  executeTransaction: (bundle: Bundle, sourceTag: string) => Promise<Bundle>;
  now: () => Date;
}

const defaultStartExamApi: StartExamApi = {
  async loadVisitTypes() {
    return await searchAll<HealthcareService>(fhir, "HealthcareService", {
      active: "true",
      _count: "100",
    });
  },
  async loadPrograms(patientId) {
    const bundle = await fhir.search<EpisodeOfCare>("EpisodeOfCare", {
      patient: `Patient/${patientId}`,
      status: "active",
      _count: "20",
    });
    return (bundle.entry ?? [])
      .flatMap((entry) => (entry.resource ? [entry.resource] : []));
  },
  async assignProvider(patientId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_ASSIGNMENT_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${clinicalGraphApiBase()}/clinical-graph/patients/${encodeURIComponent(patientId)}/assign-provider`,
        {
          method: "POST",
          headers: {
            Authorization: fhir.authHeader() ?? "",
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Provider assignment failed (${response.status}).`);
      }
    } finally {
      clearTimeout(timeout);
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
  const [visitTypes, setVisitTypes] = useState<{ id: string; label: string }[]>([]);
  const [visitTypesLoading, setVisitTypesLoading] = useState(true);
  const [visitTypeId, setVisitTypeId] = useState("");
  const [startMode, setStartMode] = useState<"standalone" | "existing" | "new">("standalone");
  const [programType, setProgramType] = useState<EpisodeOfCareTypeCode>("glaucoma");
  const [selectedProgramId, setSelectedProgramId] = useState("");
  const [programs, setPrograms] = useState<EpisodeOfCare[]>([]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [pendingEncounter, setPendingEncounter] = useState<{
    patientId: string;
    encounterId: string;
    episodeReference?: string;
  }>();
  const [pendingNewProgram, setPendingNewProgram] = useState<{
    patientId: string;
    typeCode: EpisodeOfCareTypeCode;
    episodeReference: string;
  }>();
  const reusableEncounter = pendingEncounter !== undefined && pendingEncounter.patientId === patient.id
    ? pendingEncounter
    : undefined;
  const retryingEncounter = reusableEncounter !== undefined;
  const retryingProgram = pendingNewProgram !== undefined && pendingNewProgram.patientId === patient.id;
  const lockStartOptions = starting || retryingEncounter || retryingProgram;

  useEffect(() => {
    setPendingEncounter(undefined);
    setPendingNewProgram(undefined);
  }, [patient.id]);

  useEffect(() => {
    let cancelled = false;
    setVisitTypesLoading(true);
    api.loadVisitTypes()
      .then((resources) => {
        if (cancelled) return;
        const options = resources
          .filter((visitType) => visitType.active !== false)
          .flatMap((visitType) => {
            const id = visitTypeCode(visitType);
            return id ? [{ id, label: visitType.name ?? id }] : [];
          });
        setVisitTypes(options);
        if (options.length === 0) {
          setStartError("No active coded visit types are configured for this practice.");
        }
        setVisitTypeId((current) =>
          options.some((option) => option.id === current) ? current : options[0]?.id ?? ""
        );
      })
      .catch((reason: unknown) => {
        if (!cancelled) setStartError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setVisitTypesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

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
    const visitType = visitTypes.find((candidate) => candidate.id === visitTypeId);
    if (!visitType) {
      setStartError("Choose an active practice visit type before starting the visit.");
      return;
    }

    setStarting(true);
    setStartError(null);
    try {
      const now = api.now();
      let encounterId = reusableEncounter?.encounterId;
      if (!encounterId) {
        await assignProvider(patient.id);
        const episodeReference = await resolveProgramReference();
        const createResponse = await api.executeTransaction(
          buildStartEncounterCreateBundle({
            patientId: patient.id,
            now: now.toISOString(),
            episodeReference,
            visitType: {
              coding: [{
                system: ODOS_VISIT_TYPE_SYSTEM,
                code: visitType.id,
                display: visitType.label,
              }],
              text: visitType.label,
            },
          }),
          "start_encounter",
        );
        assertTransactionSuccess(createResponse);

        encounterId = createdIdFromEntry(createResponse, 0, "Encounter");
        setPendingEncounter({ patientId: patient.id, encounterId, episodeReference });
      }
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

      setPendingEncounter(undefined);
      setPendingNewProgram(undefined);
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

    if (pendingNewProgram?.patientId === patient.id && pendingNewProgram.typeCode === programType) {
      return pendingNewProgram.episodeReference;
    }
    const created = await api.createProgram({
      patientReference: `Patient/${patient.id}`,
      typeCode: programType,
    });
    const episodeReference = `EpisodeOfCare/${created.id}`;
    setPendingNewProgram({ patientId: patient.id, typeCode: programType, episodeReference });
    return episodeReference;
  }

  return (
    <div data-testid="start-exam-prompt" className="odos-start-exam">
      <div className="odos-start-exam-title">Start today's visit</div>
      <div className="odos-start-exam-select">
        <div className="odos-start-exam-field-label">Visit type</div>
        <OdosSelect
          value={visitTypeId}
          options={[
            { value: "", label: visitTypesLoading ? "Loading visit types…" : "Select a visit type" },
            ...visitTypes.map((visitType) => ({
              value: visitType.id,
              label: visitType.label,
            })),
          ]}
          onChange={setVisitTypeId}
          disabled={lockStartOptions || visitTypesLoading}
          ariaLabel="Visit type"
        />
      </div>
      <div className="odos-start-exam-field-label">Program enrollment</div>
      <div className="odos-start-exam-modes">
        <StartModeButton active={startMode === "standalone"} disabled={lockStartOptions} onClick={() => setStartMode("standalone")}>Stand-alone visit</StartModeButton>
        <StartModeButton active={startMode === "existing"} disabled={lockStartOptions} onClick={() => setStartMode("existing")}>Part of an existing program</StartModeButton>
        <StartModeButton active={startMode === "new"} disabled={lockStartOptions} onClick={() => setStartMode("new")}>Start a new program</StartModeButton>
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
            disabled={lockStartOptions}
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
            disabled={lockStartOptions}
          />
        </div>
      )}

      {startError && <p className="odos-overview-error" role="alert">{startError}</p>}
      <button
        type="button"
        disabled={!patient.id || starting || visitTypesLoading || !visitTypeId || visitTypes.length === 0 || (startMode === "existing" && !selectedProgramId)}
        onClick={() => void startExam()}
        className="odos-overview-button is-primary odos-start-exam-submit"
      >
        {starting ? "Starting visit…" : retryingEncounter ? "Retry starting today's visit →" : "Start today's visit →"}
      </button>
    </div>
  );
}

function StartModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
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
