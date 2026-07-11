import { useEffect, useMemo, useState } from "react";
import type { Condition, Encounter, Patient } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import {
  assertTransactionSuccess,
  buildEncounterStatusPatchBundle,
} from "../../lib/encounter-bundles";
import { useViewState } from "../../lib/view-state";
import { RoleSelector } from "../RoleSelector";
import {
  computeMdmHint,
  isEncounterDiagnosisCondition,
  isProblemListCondition,
} from "../../lib/clinical-view-model";
import { patientName } from "../../lib/scheduler-appointment-ui";
import {
  readDiagnosisCompleteness,
  type DiagnosisCompleteness,
} from "../../lib/clinical-graph-client";

interface Props {
  patient: Patient;
  encounterId: string;
}

export function EncounterHeader({ patient, encounterId }: Props) {
  const setView = useViewState((state) => state.setView);
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [encounterConditions, setEncounterConditions] = useState<Condition[]>([]);
  const [problemListConditions, setProblemListConditions] = useState<Condition[]>([]);
  const [busy, setBusy] = useState<"checking" | "finish" | "abandon" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completenessAdvisories, setCompletenessAdvisories] = useState<DiagnosisCompleteness["diagnoses"]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadEncounter() {
      try {
        const loaded = await fhir.read<Encounter>("Encounter", encounterId);
        const [encounterConditionBundle, problemBundle] = await Promise.all([
          fhir.search<Condition>("Condition", {
            encounter: `Encounter/${encounterId}`,
            _count: "40",
          }),
          fhir.search<Condition>("Condition", {
            subject: `Patient/${patient.id}`,
            _count: "80",
          }),
        ]);
        if (!cancelled) {
          setEncounter(loaded);
          setEncounterConditions(
            (encounterConditionBundle.entry ?? [])
              .flatMap((entry) => (entry.resource ? [entry.resource] : []))
              .filter(isEncounterDiagnosisCondition),
          );
          setProblemListConditions(
            (problemBundle.entry ?? [])
              .flatMap((entry) => (entry.resource ? [entry.resource] : []))
              .filter(isProblemListCondition),
          );
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void loadEncounter();
    return () => {
      cancelled = true;
    };
  }, [encounterId, patient.id]);

  const displayName = useMemo(() => patientName(patient), [patient]);
  const mdmHint = useMemo(
    () =>
      encounter
        ? computeMdmHint({ encounter, encounterConditions, problemListConditions })
        : undefined,
    [encounter, encounterConditions, problemListConditions],
  );

  async function finishEncounter() {
    if (!patient.id) return;
    setBusy("finish");
    setError(null);
    try {
      const now = new Date().toISOString();
      const response = await fhir.executeTransaction(
        buildEncounterStatusPatchBundle({
          encounterId,
          patientId: patient.id,
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

  async function requestFinishEncounter() {
    if (!patient.id || busy) return;
    setBusy("checking");
    setError(null);
    await runSignTimeCompletenessCheck(
      () => readDiagnosisCompleteness(encounterId),
      finishEncounter,
      (diagnoses) => {
        setCompletenessAdvisories(diagnoses);
        setBusy(null);
      },
    );
  }

  async function abandonEncounter() {
    if (!patient.id || busy) return;
    setBusy("abandon");
    setError(null);
    try {
      const response = await fhir.executeTransaction(
        buildEncounterStatusPatchBundle({
          encounterId,
          patientId: patient.id,
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

        <div className="flex flex-wrap items-center gap-2">
          <RoleSelector />
          <button
            onClick={abandonEncounter}
            disabled={busy !== null}
            className="rounded border border-white/15 px-3 py-2 text-sm text-white/65 transition hover:border-red-400/60 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "abandon" ? "Abandoning..." : "Abandon encounter"}
          </button>
          <button
            onClick={requestFinishEncounter}
            disabled={busy !== null}
            className="rounded border border-emerald-400/60 bg-emerald-400/15 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "checking" ? "Checking..." : busy === "finish" ? "Signing..." : "Sign & finish"}
          </button>
        </div>
      </div>

      {mdmHint && (
        <div data-testid="mdm-hint-counter" className="mt-3 rounded border border-white/10 bg-bg-deep/70 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-widest text-white/35">MDM problem counter</div>
              <div className="mt-1 text-sm text-white/70">
                Deterministic count from visit diagnoses and active problem list.
              </div>
            </div>
            <div className="rounded border border-emerald-400/50 bg-emerald-400/10 px-3 py-2 text-sm font-semibold text-emerald-100">
              {mdmHint.tier} MDM threshold
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-white/50 sm:grid-cols-5">
            <span>{mdmHint.counts.stableChronic} stable chronic</span>
            <span>{mdmHint.counts.minorSelfLimited} minor</span>
            <span>{mdmHint.counts.chronicExacerbation} exacerbated</span>
            <span>{mdmHint.counts.acuteUncomplicated} acute uncomplicated</span>
            <span>{mdmHint.counts.severeExacerbationOrSystemic} severe/systemic</span>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">
          {error}
        </div>
      )}
      {completenessAdvisories.length > 0 && (
        <DiagnosisCompletenessDialog
          diagnoses={completenessAdvisories}
          signing={busy === "finish"}
          onSignAnyway={() => void finishEncounter()}
          onAddFindings={() => setCompletenessAdvisories([])}
        />
      )}
    </header>
  );
}

export async function runSignTimeCompletenessCheck(
  readCompleteness: () => Promise<DiagnosisCompleteness>,
  sign: () => Promise<void>,
  showAdvisories: (diagnoses: DiagnosisCompleteness["diagnoses"]) => void,
): Promise<void> {
  try {
    const result = await readCompleteness();
    if (result.diagnoses.length) {
      showAdvisories(result.diagnoses);
      return;
    }
  } catch {
    // The completeness read is advisory-only; signing remains available when it fails.
  }
  await sign();
}

export function DiagnosisCompletenessDialog({
  diagnoses,
  signing,
  onSignAnyway,
  onAddFindings,
}: {
  diagnoses: DiagnosisCompleteness["diagnoses"];
  signing: boolean;
  onSignAnyway: () => void;
  onAddFindings: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Diagnosis key findings advisory">
      <div className="w-full max-w-lg rounded border border-white/15 bg-bg-panel p-5 shadow-2xl">
        <div className="text-xs uppercase tracking-widest text-white/35">Before signing</div>
        <div className="mt-3 grid gap-2 text-sm text-white/70">
          {diagnoses.map((diagnosis) => (
            <div key={diagnosis.conditionReference ?? `${diagnosis.diagnosisKey}:${diagnosis.laterality}`}>
              {diagnosis.display} is active without: {diagnosis.missing.map((finding) => finding.display).join(" · ")}
            </div>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="scheduler-button" disabled={signing} onClick={onAddFindings}>
            Add findings
          </button>
          <button type="button" className="scheduler-button" disabled={signing} onClick={onSignAnyway}>
            {signing ? "Signing..." : "Sign anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}
