import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import type { Condition, Encounter, Patient } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import {
  assertTransactionSuccess,
  buildEncounterStatusPatchBundle,
} from "../../lib/encounter-bundles";
import { patientOverviewView, useViewState } from "../../lib/view-state";
import { RoleSelector } from "../RoleSelector";
import {
  computeMdmHint,
  isEncounterDiagnosisCondition,
  isProblemListCondition,
} from "../../lib/clinical-view-model";
import { patientName } from "../../lib/scheduler-appointment-ui";
import {
  authHeaders,
  clinicalGraphApiBase,
  readDiagnosisCompleteness,
  type DiagnosisCompleteness,
} from "../../lib/clinical-graph-client";
import { BalanceChips } from "../commercial/BalanceChips";
import {
  formatSeriesDueWindow,
  formatSeriesSignOffPrompt,
  signOffSeriesProcedures,
  type SeriesSignOffPrompt,
} from "../../lib/series-tracker";

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
  const [seriesPrompt, setSeriesPrompt] = useState<SeriesSignOffPrompt>();
  const completenessCheckVersion = useRef(0);

  useEffect(() => {
    let cancelled = false;
    completenessCheckVersion.current += 1;
    setCompletenessAdvisories([]);
    setBusy((current) => current === "checking" ? null : current);

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
      completenessCheckVersion.current += 1;
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
    if (!patient.id || busy === "finish" || busy === "abandon") return;
    setBusy("finish");
    setError(null);
    try {
      const cleanup = await fetch(`${clinicalGraphApiBase()}/clinical-graph/protocols/encounters/${encodeURIComponent(encounterId)}/sign-cleanup`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!cleanup.ok) throw new Error(`Protocol sign cleanup failed: ${cleanup.status}`);
      const now = new Date().toISOString();
      const response = await fhir.executeTransaction(
        buildEncounterStatusPatchBundle({
          encounterId,
          patientId: patient.id,
          recorded: now,
          operatorDisplay: "ODOS UI finish_encounter",
          ops: [
            { op: "replace", path: "/status", value: "finished" },
            { op: "add", path: "/period/end", value: now },
          ],
        }),
        "finish_encounter",
      );
      assertTransactionSuccess(response);
      const seriesSignOff = await signOffSeriesProcedures(encounterId);
      if (seriesSignOff.prompt) {
        setSeriesPrompt(seriesSignOff.prompt);
      } else {
        setView(patientOverviewView(patient.id));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function requestFinishEncounter() {
    if (!patient.id || busy) return;
    const requestVersion = ++completenessCheckVersion.current;
    setBusy("checking");
    setError(null);
    await runSignTimeCompletenessCheck(
      () => readDiagnosisCompleteness(encounterId),
      async () => {
        if (requestVersion === completenessCheckVersion.current) await finishEncounter();
      },
      (diagnoses) => {
        if (requestVersion !== completenessCheckVersion.current) return;
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
          operatorDisplay: "ODOS UI abandon_encounter",
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
      setView(patientOverviewView(patient.id));
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
          {patient.id && <BalanceChips patientReference={`Patient/${patient.id}`} />}
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
          signing={busy !== null}
          onSignAnyway={() => void finishEncounter()}
          onAddFindings={() => setCompletenessAdvisories([])}
        />
      )}
      {seriesPrompt && (
        <SeriesSignOffNotice
          prompt={seriesPrompt}
          onClose={() => setView(patientOverviewView(patient.id ?? ""))}
        />
      )}
    </header>
  );
}

export function SeriesSignOffNotice({
  prompt,
  onClose,
}: {
  prompt: SeriesSignOffPrompt;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Next series session due">
      <div className="w-full max-w-md rounded border border-violet-300/25 bg-bg-panel p-5 shadow-2xl">
        <div className="text-xs uppercase tracking-widest text-violet-200/55">Series updated</div>
        <h2 className="mt-2 text-lg font-semibold text-white">{prompt.protocolTitle}</h2>
        <p className="mt-3 text-sm text-white/75">{formatSeriesSignOffPrompt(prompt)}</p>
        <p className="mt-2 text-sm font-medium text-violet-100">{formatSeriesDueWindow(prompt.dueWindow)}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="scheduler-button" onClick={onClose}>Return to chart</button>
          <a className="scheduler-button" href="/scheduler/day">Open scheduler</a>
        </div>
      </div>
    </div>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstActionRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onAddFindings();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    if (!focusable.length) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Diagnosis key findings advisory"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="w-full max-w-lg rounded border border-white/15 bg-bg-panel p-5 shadow-2xl">
        <div className="text-xs uppercase tracking-widest text-white/35">Before signing</div>
        <div className="mt-3 grid gap-2 text-sm text-white/70">
          {diagnoses.map((diagnosis, index) => (
            <div key={diagnosis.conditionReference ?? `${diagnosis.diagnosisKey}:${diagnosis.laterality}:${index}`}>
              {diagnosis.display} is active without: {diagnosis.missing.map((finding) => finding.display).join(" · ")}
            </div>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <DiagnosisCompletenessDialogActions
            signing={signing}
            firstActionRef={firstActionRef}
            onAddFindings={onAddFindings}
            onSignAnyway={onSignAnyway}
          />
        </div>
      </div>
    </div>
  );
}

export function DiagnosisCompletenessDialogActions({
  signing,
  firstActionRef,
  onSignAnyway,
  onAddFindings,
}: {
  signing: boolean;
  firstActionRef?: Ref<HTMLButtonElement>;
  onSignAnyway: () => void;
  onAddFindings: () => void;
}) {
  return (
    <>
      <button ref={firstActionRef} type="button" className="scheduler-button" disabled={signing} onClick={onAddFindings}>
        Add findings
      </button>
      <button type="button" className="scheduler-button" disabled={signing} onClick={onSignAnyway}>
        {signing ? "Signing..." : "Sign anyway"}
      </button>
    </>
  );
}
