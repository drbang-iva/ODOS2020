import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import type { Appointment, Encounter, Patient } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import {
  assertTransactionSuccess,
  buildEncounterStatusPatchBundle,
} from "../../lib/encounter-bundles";
import { openPatientOverview } from "../../lib/view-state";
import { RoleSelector } from "../RoleSelector";
import type { MdmHint } from "../../lib/clinical-view-model";
import { patientName } from "../../lib/scheduler-appointment-ui";
import {
  authHeaders,
  clinicalGraphApiBase,
  readDiagnosisCompleteness,
  type DiagnosisCompleteness,
  type VisitChargeResponse,
  type VisitProcedureFamily,
} from "../../lib/clinical-graph-client";
import { isMigratedEncounter } from "../../lib/patient-overview";
import {
  formatSeriesDueWindow,
  formatSeriesSignOffPrompt,
  signOffSeriesProcedures,
  type SeriesSignOffPrompt,
} from "../../lib/series-tracker";
import {
  isFollowUpAppointment,
  isUrgentAppointment,
  ODOS_VISIT_TYPE_SYSTEM,
} from "../../lib/scheduling";
import {
  ExamCompletenessControl,
  type ClinicalExamCompleteness,
} from "./ExamOverviewBoard";

interface Props {
  patient: Patient;
  encounterId: string;
  completeness?: ClinicalExamCompleteness;
  unassignedCount?: number;
  visitCharge?: VisitChargeResponse;
  brokenDiagnosisDisplay?: string;
  visitChargesOpen?: boolean;
  visitUnavailableReason?: string;
  onToggleVisitCharges?: () => void;
}

export function EncounterHeader({
  patient,
  encounterId,
  completeness,
  unassignedCount,
  visitCharge,
  brokenDiagnosisDisplay,
  visitChargesOpen = false,
  visitUnavailableReason,
  onToggleVisitCharges,
}: Props) {
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [appointmentError, setAppointmentError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"checking" | "finish" | "abandon" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completenessAdvisories, setCompletenessAdvisories] = useState<DiagnosisCompleteness["diagnoses"]>([]);
  const [seriesPrompt, setSeriesPrompt] = useState<SeriesSignOffPrompt>();
  const [blackedOut, setBlackedOut] = useState(false);
  const focusBeforeBlackout = useRef<{ focus: () => void }>();
  const blackoutOverlay = useRef<HTMLDivElement>(null);
  const completenessCheckVersion = useRef(0);

  useEffect(() => {
    let cancelled = false;
    completenessCheckVersion.current += 1;
    setCompletenessAdvisories([]);
    setBusy((current) => current === "checking" ? null : current);

    async function loadEncounter() {
      try {
        const loaded = await fhir.read<Encounter>("Encounter", encounterId);
        if (!cancelled) {
          setEncounter(loaded);
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ encounterReference?: string }>).detail;
      if (detail?.encounterReference !== `Encounter/${encounterId}`) return;
      void fhir.read<Encounter>("Encounter", encounterId)
        .then((loaded) => {
          if (!cancelled) setEncounter(loaded);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    window.addEventListener("odos:encounter-diagnosis-updated", refresh);
    window.addEventListener("odos:diagnosis-picked", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("odos:encounter-diagnosis-updated", refresh);
      window.removeEventListener("odos:diagnosis-picked", refresh);
    };
  }, [encounterId]);

  useEffect(() => {
    const reference = encounter?.appointment?.find((candidate) =>
      candidate.reference?.includes("Appointment/"),
    )?.reference;
    const appointmentId = reference?.match(/(?:^|\/)Appointment\/([^/?#]+)/)?.[1];
    if (!appointmentId) {
      setAppointment(null);
      setAppointmentError(null);
      return;
    }
    let cancelled = false;
    setAppointment(null);
    setAppointmentError(null);
    void fhir.read<Appointment>("Appointment", appointmentId)
      .then((loaded) => {
        if (!cancelled) setAppointment(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setAppointmentError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [encounter]);

  const displayName = useMemo(() => patientName(patient), [patient]);
  useEffect(() => {
    if (blackedOut) blackoutOverlay.current?.focus();
  }, [blackedOut]);
  const migrated = isMigratedEncounter(encounter);

  async function finishEncounter() {
    if (!patient.id || migrated || busy === "finish" || busy === "abandon") return;
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
        openPatientOverview(patient.id, "replace");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function requestFinishEncounter() {
    if (!patient.id || migrated || busy) return;
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
    if (!patient.id || migrated || busy) return;
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
      openPatientOverview(patient.id, "replace");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function enterBlackout() {
    const activeElement = typeof document === "undefined" ? undefined : document.activeElement;
    focusBeforeBlackout.current = activeElement && "focus" in activeElement &&
        typeof activeElement.focus === "function"
      ? activeElement as { focus: () => void }
      : undefined;
    setBlackedOut(true);
  }

  function restoreFromBlackout() {
    const focusTarget = focusBeforeBlackout.current;
    setBlackedOut(false);
    void Promise.resolve().then(() => focusTarget?.focus());
  }

  return (
    <header className="border-b border-white/10 bg-bg-panel">
      <ExamChartBar
        patientName={displayName}
        patientDetail={[
          patient.birthDate ? `DOB ${patient.birthDate}` : undefined,
          migrated ? "Migrated" : encounter?.status ?? "loading",
        ].filter(Boolean).join(" · ")}
        completeness={completeness}
        unassignedCount={unassignedCount}
        visitCharge={visitCharge}
        brokenDiagnosisDisplay={brokenDiagnosisDisplay}
        visitControlsOpen={visitChargesOpen}
        visitUnavailableReason={visitUnavailableReason}
        onToggleVisitControls={() => {
          if (!visitUnavailableReason) onToggleVisitCharges?.();
        }}
        onBlackout={enterBlackout}
        requestFinishEncounter={requestFinishEncounter}
        signDisabled={busy !== null || migrated}
        signLabel={busy === "checking" ? "Checking..." : busy === "finish" ? "Signing..." : "Sign & finish"}
      />

      <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <RoleSelector />
          <button
            type="button"
            onClick={abandonEncounter}
            disabled={busy !== null || migrated}
            title={migrated ? "Migrated historical encounters are read-only." : undefined}
            className="min-h-11 rounded border border-white/15 px-3 py-2 text-sm text-white/65 transition hover:border-red-400/60 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "abandon" ? "Abandoning..." : "Abandon encounter"}
          </button>
        </div>
      </div>

      <div className="px-5 pb-4">
        {appointment && <AppointmentContextBanner appointment={appointment} />}

        {error && (
          <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">
            {error}
          </div>
        )}
        {appointmentError && (
          <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">
            Linked appointment could not be loaded: {appointmentError}
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
            onClose={() => patient.id && openPatientOverview(patient.id, "replace")}
          />
        )}
      </div>

      {blackedOut && (
        <div
          ref={blackoutOverlay}
          data-testid="blackout-overlay"
          className="odos-blackout-overlay"
          role="button"
          tabIndex={0}
          aria-label="Restore screen"
          onClick={restoreFromBlackout}
          onBlur={() => blackoutOverlay.current?.focus()}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              event.preventDefault();
              blackoutOverlay.current?.focus();
              return;
            }
            if (event.key !== "Escape" && event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            restoreFromBlackout();
          }}
        />
      )}
    </header>
  );
}

interface ExamChartBarProps {
  patientName: string;
  patientDetail: string;
  completeness?: ClinicalExamCompleteness;
  unassignedCount?: number;
  visitCharge?: VisitChargeResponse;
  brokenDiagnosisDisplay?: string;
  visitControlsOpen: boolean;
  visitUnavailableReason?: string;
  onToggleVisitControls: () => void;
  onBlackout: () => void;
  requestFinishEncounter: () => void | Promise<void>;
  signDisabled: boolean;
  signLabel: string;
}

export function ExamChartBar({
  patientName: name,
  patientDetail,
  completeness,
  unassignedCount,
  visitCharge,
  brokenDiagnosisDisplay,
  visitControlsOpen,
  visitUnavailableReason,
  onToggleVisitControls,
  onBlackout,
  requestFinishEncounter,
  signDisabled,
  signLabel,
}: ExamChartBarProps) {
  const visit = visitChipView(visitCharge, brokenDiagnosisDisplay);
  return (
    <div className="odos-exam-chart-bar" data-testid="exam-chart-bar">
      <div className="odos-chart-bar-patient" data-chart-bar-slot="patient">
        <span>Patient</span>
        <strong>{name}</strong>
        {patientDetail && <small>{patientDetail}</small>}
      </div>
      <div
        className="odos-chart-bar-cc-reserved"
        data-chart-bar-slot="cc-hpi-reserved"
        aria-hidden={true}
      />
      <div className="odos-chart-bar-sections" data-chart-bar-slot="exam-sections">
        <ExamCompletenessControl completeness={completeness} />
      </div>
      <div
        className="odos-chart-bar-count"
        data-chart-bar-slot="drafts"
        data-reserved-for="slice-4-drafts"
        aria-hidden={true}
      />
      <div className="odos-chart-bar-count is-unassigned" data-chart-bar-slot="unassigned">
        {unassignedCount === undefined ? "Unassigned unavailable" : `${unassignedCount} unassigned`}
      </div>
      <button
        type="button"
        className="odos-chart-bar-visit"
        data-chart-bar-slot="visit"
        data-testid="visit-chip"
        aria-expanded={visitControlsOpen}
        aria-controls="visit-charges-sheet"
        aria-disabled={visitUnavailableReason ? true : undefined}
        onClick={onToggleVisitControls}
      >
        {visit.kind === "none" ? (
          <strong>Visit — none</strong>
        ) : (
          <>
            <span className="odos-chart-bar-visit-label">
              <small>Visit</small>
              <strong>{visit.label}</strong>
              {visit.kind === "linked" && <span>linked diagnosis {visit.diagnosis}</span>}
            </span>
            {visit.kind === "empty" && (
              <BillingIntegrityMarker state="empty" full="no diagnosis linked" short="no dx linked" />
            )}
            {visit.kind === "broken" && (
              <BillingIntegrityMarker
                state="broken"
                full={`broken linked diagnosis ${visit.diagnosis}`}
                short={`broken · ${visit.diagnosis}`}
              />
            )}
          </>
        )}
        {visitUnavailableReason && (
          <span className="odos-chart-bar-visit-unavailable">{visitUnavailableReason}</span>
        )}
      </button>
      <button
        type="button"
        className="odos-chart-bar-blackout"
        data-chart-bar-slot="blackout"
        data-testid="blackout-control"
        aria-label="Black out screen"
        onClick={onBlackout}
      >
        <span aria-hidden="true">●</span>
        <span className="odos-chart-bar-blackout-label">Blackout</span>
      </button>
      <button
        type="button"
        className="odos-chart-bar-sign"
        data-chart-bar-slot="sign"
        disabled={signDisabled}
        onClick={requestFinishEncounter}
      >
        <span className="odos-chart-bar-sign-full">{signLabel}</span>
        <span className="odos-chart-bar-sign-short">Sign</span>
      </button>
    </div>
  );
}

function BillingIntegrityMarker({
  state,
  full,
  short,
}: {
  state: "empty" | "broken";
  full: string;
  short: string;
}) {
  return (
    <span
      className="odos-billing-integrity-marker"
      data-billing-integrity={state}
      data-short-label={`◇ ${short}`}
      aria-label={`Billing integrity: ${full}`}
    >
      ◇ {full}
    </span>
  );
}

type VisitChipView =
  | { kind: "none" }
  | { kind: "linked"; label: string; diagnosis: string }
  | { kind: "empty"; label: string }
  | { kind: "broken"; label: string; diagnosis: string };

function visitChipView(
  response: VisitChargeResponse | undefined,
  brokenDiagnosisDisplay: string | undefined,
): VisitChipView {
  const proposal = response?.proposal?.state === "accepted" ? response.proposal : undefined;
  const selectedKey = response?.selectedProcedureConceptKey ?? proposal?.procedureConceptKey;
  if (!selectedKey || !proposal) return { kind: "none" };
  const option = response?.options.find((candidate) => candidate.procedureConceptKey === selectedKey);
  const label = option?.billingCode ?? option?.display ?? selectedKey;
  const diagnosisReference = proposal.dxPointers[0];
  if (!diagnosisReference) return { kind: "empty", label };
  const diagnosis = response?.diagnoses.find((candidate) => candidate.reference === diagnosisReference);
  if (diagnosis) return { kind: "linked", label, diagnosis: diagnosis.display };
  return {
    kind: "broken",
    label,
    diagnosis: brokenDiagnosisDisplay ?? diagnosisReference,
  };
}

export function MdmProblemsAxis({
  mdmHint,
  procedureFamily,
}: {
  mdmHint: MdmHint;
  procedureFamily: VisitProcedureFamily | null | undefined;
}) {
  if (procedureFamily !== "em") return null;
  return (
    <div data-testid="mdm-hint-counter" className="mt-3 rounded border border-white/10 bg-bg-deep/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-white/35">MDM problems axis</div>
          <div className="mt-1 text-sm text-white/70">
            Clinician-entered problem-status facts. This neither selects nor validates the visit code.
          </div>
        </div>
        {mdmHint.status === "blocked" ? (
          <div className="rounded border border-amber-400/60 bg-amber-400/10 px-3 py-2 text-sm font-semibold text-amber-100">
            Problem-status facts unavailable · {mdmHint.reason}
          </div>
        ) : (
          <div className="rounded border border-emerald-400/50 bg-emerald-400/10 px-3 py-2 text-sm font-semibold text-emerald-100">
            {mdmHint.tier} MDM threshold
          </div>
        )}
      </div>
      {mdmHint.status === "ready" && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-white/50 sm:grid-cols-4 xl:grid-cols-8">
          <span>{mdmHint.counts.minimalSelfLimited} minimal</span>
          <span>{mdmHint.counts.stableChronic} stable chronic</span>
          <span>{mdmHint.counts.chronicExacerbationProgression} exacerbated</span>
          <span>{mdmHint.counts.chronicSevereExacerbation} severe exacerbation</span>
          <span>{mdmHint.counts.acuteUncomplicated} acute uncomplicated</span>
          <span>{mdmHint.counts.acuteComplicatedOrSystemic} acute complicated/systemic</span>
          <span>{mdmHint.counts.undiagnosedNewProblemUncertainPrognosis} uncertain prognosis</span>
          <span>{mdmHint.counts.threatToLifeOrBodilyFunction} threat to life/function</span>
        </div>
      )}
    </div>
  );
}

export function AppointmentContextBanner({ appointment }: { appointment: Appointment }) {
  const note = appointment.comment?.trim();
  const visitType = appointment.serviceType?.[0]?.text
    ?? appointment.serviceType?.[0]?.coding?.find(
      (coding) => coding.system === ODOS_VISIT_TYPE_SYSTEM,
    )?.display
    ?? appointment.serviceType?.[0]?.coding?.find(
      (coding) => coding.system === ODOS_VISIT_TYPE_SYSTEM,
    )?.code
    ?? "Appointment";

  return (
    <div
      data-testid="appointment-context-banner"
      className="mt-3 rounded border border-[var(--odos-overlay-line-2)] bg-[color-mix(in_srgb,var(--odos-text)_10%,transparent)] px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-widest text-[color:var(--odos-muted)]">
          Booked visit · {visitType}
        </span>
        {isUrgentAppointment(appointment) && (
          <span className="rounded-sm bg-[color:var(--odos-accent-tint-hi)] px-2 py-0.5 text-xs font-bold uppercase text-[color:var(--odos-text)]">
            Urgent
          </span>
        )}
        {isFollowUpAppointment(appointment) && (
          <span className="rounded-sm bg-[color:var(--odos-accent-tint-hi)] px-2 py-0.5 text-xs font-bold uppercase text-[color:var(--odos-text)]">
            Follow-up
          </span>
        )}
      </div>
      {note && (
        <div className="mt-2 whitespace-pre-wrap break-words text-sm font-medium text-[color:var(--odos-text)]">
          {note}
        </div>
      )}
    </div>
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
