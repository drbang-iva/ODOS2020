import type { Appointment, Coverage, HealthcareService, Schedule } from "@medplum/fhirtypes";
import { useEffect, useMemo, useState } from "react";
import { fhir } from "../../lib/fhir";
import {
  fetchPatientInsurance,
  type InsuranceScreenData,
} from "../../lib/patient-insurance";
import {
  APPOINTMENT_CONFIRMATION_STATUSES,
  ODOS_APPOINTMENT_STATUSES,
  resourceDisplay,
  scheduleReference,
  visitTypeCode,
  visitTypeDurationMinutes,
  visibleSchedulingVisitTypes,
  type AppointmentConfirmationStatus,
  type ClinicMode,
  type OdosAppointmentStatus,
} from "../../lib/scheduling";
import {
  appointmentModalDurationError,
  appointmentModalDraftFromAppointment,
  confirmDoubleBookAndRetry,
  dateInputValue,
  defaultAppointmentModalDraft,
  draftToAppointmentChanges,
  draftToBookInput,
  patientName,
  timeInputValue,
  withDateAndTime,
  type AppointmentModalDraft,
} from "../../lib/scheduler-appointment-ui";
import type {
  AppointmentChangeInput,
  SchedulingWriteDeps,
} from "../../lib/scheduling-store";
import { coveragePlanName, coverageType } from "../../lib/submit-claims";
import { PatientSearch } from "../PatientPicker";
import {
  referralApi,
  type ReferralApi,
  type ReferralConsultant,
} from "../../components/referral/referral-api";

const DURATION_PRESETS = [10, 15, 30, 60] as const;

type PatientInsuranceLoader = (patientReference: string) => Promise<InsuranceScreenData>;

const defaultPatientInsuranceLoader: PatientInsuranceLoader = (patientReference) =>
  fetchPatientInsurance(patientReference, {
    authorization: fhir.authHeader(),
    baseUrl: import.meta.env.VITE_ODOS_MCP_BASE_URL?.replace(/\/$/, "") ?? "",
  });

export function AppointmentDetailsModal({
  appointment,
  initialDraft,
  clinicMode,
  timezoneOffset,
  resources,
  visitTypes,
  onClose,
  onCreate,
  onUpdate,
  onSetStatus,
  loadPatientInsurance = defaultPatientInsuranceLoader,
  correspondenceApi = referralApi,
}: {
  appointment?: Appointment;
  initialDraft?: AppointmentModalDraft;
  clinicMode: ClinicMode;
  timezoneOffset: string;
  resources: Schedule[];
  visitTypes: HealthcareService[];
  onClose: () => void;
  onCreate: (input: ReturnType<typeof draftToBookInput>, deps?: SchedulingWriteDeps) => Promise<void>;
  onUpdate: (
    appointment: Appointment,
    changes: AppointmentChangeInput,
    deps?: SchedulingWriteDeps,
  ) => Promise<void>;
  onSetStatus: (
    appointment: Appointment,
    status: OdosAppointmentStatus,
    deps?: SchedulingWriteDeps,
  ) => Promise<void>;
  loadPatientInsurance?: PatientInsuranceLoader;
  correspondenceApi?: Pick<ReferralApi, "searchConsultants" | "createInboundReferral">;
}) {
  const fallbackDraft = useMemo(
    () => {
      if (appointment) {
        return undefined;
      }
      if (initialDraft) {
        return initialDraft;
      }
      const resource = resources[0];
      if (!resource) {
        return undefined;
      }
      return defaultAppointmentModalDraft({
        date: new Date().toISOString().slice(0, 10),
        startMinutes: 9 * 60,
        timezoneOffset,
        resources,
        visitTypes,
        clinicMode,
        resource,
      });
    },
    [appointment, clinicMode, initialDraft, resources, timezoneOffset, visitTypes],
  );
  const createDisabled = !appointment && !fallbackDraft;
  const [draft, setDraft] = useState<AppointmentModalDraft>(
    appointment ? appointmentModalDraftFromAppointment(appointment, resources) : fallbackDraft ?? emptyDraft(timezoneOffset),
  );
  const [patientQueryOpen, setPatientQueryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durationCustom, setDurationCustom] = useState(
    () => !isDurationPreset(appointment ? appointmentModalDraftFromAppointment(appointment, resources).durationMinutes : fallbackDraft?.durationMinutes ?? 30),
  );
  const [patientCoverages, setPatientCoverages] = useState<Coverage[] | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [visionOther, setVisionOther] = useState(false);
  const [medicalOther, setMedicalOther] = useState(false);
  const [referrerQuery, setReferrerQuery] = useState("");
  const [referralReason, setReferralReason] = useState("");
  const [referrerMatches, setReferrerMatches] = useState<ReferralConsultant[]>([]);
  const [appointmentSaved, setAppointmentSaved] = useState(false);

  useEffect(() => {
    const nextDraft = appointment ? appointmentModalDraftFromAppointment(appointment, resources) : fallbackDraft ?? emptyDraft(timezoneOffset);
    setDraft(nextDraft);
    setDurationCustom(!isDurationPreset(nextDraft.durationMinutes));
    setError(null);
  }, [appointment?.id, Boolean(fallbackDraft)]);

  useEffect(() => {
    const patientReference = draft.patient?.reference;
    if (!patientReference) {
      setPatientCoverages(null);
      setCoverageLoading(false);
      setCoverageError(null);
      setVisionOther(false);
      setMedicalOther(false);
      return;
    }
    let cancelled = false;
    setPatientCoverages(null);
    setCoverageLoading(true);
    setCoverageError(null);
    void loadPatientInsurance(patientReference)
      .then((data) => {
        if (cancelled) return;
        setPatientCoverages(data.coverages);
        setVisionOther(needsOtherCoverage(draft, data.coverages, "vision"));
        setMedicalOther(needsOtherCoverage(draft, data.coverages, "medical"));
      })
      .catch(() => {
        if (cancelled) return;
        setPatientCoverages([]);
        setCoverageError("Insurance plans could not be loaded; enter the display manually.");
      })
      .finally(() => {
        if (!cancelled) setCoverageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.patient?.reference, loadPatientInsurance]);

  useEffect(() => {
    const query = referrerQuery.trim();
    if (appointment || query.length < 2) {
      setReferrerMatches([]);
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(() => {
      void correspondenceApi.searchConsultants(query, controller.signal)
        .then(setReferrerMatches)
        .catch(() => {
          if (!controller.signal.aborted) setReferrerMatches([]);
        });
    }, 250);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [appointment, correspondenceApi, referrerQuery]);

  const visibleVisitTypes = useMemo(
    () => visibleSchedulingVisitTypes(visitTypes, clinicMode),
    [visitTypes, clinicMode],
  );
  const visionCoverages = useMemo(
    () => relevantCoverages(patientCoverages, "vision"),
    [patientCoverages],
  );
  const medicalCoverages = useMemo(
    () => relevantCoverages(patientCoverages, "medical"),
    [patientCoverages],
  );

  async function save(allowDoubleBook = false) {
    if (createDisabled) {
      setError("No scheduler resources are loaded for this appointment.");
      return;
    }
    const durationError = appointmentModalDurationError(draft);
    if (durationError) {
      setError(durationError);
      return;
    }
    const inboundReferral = !appointment && referrerQuery.trim()
      ? inboundReferralInput(
          draft,
          resources,
          referrerQuery,
          referralReason,
          referrerMatches,
        )
      : undefined;
    if (inboundReferral instanceof Error) {
      setError(inboundReferral.message);
      return;
    }
    setSaving(true);
    setError(null);
    let savedThisAttempt = appointmentSaved;
    try {
      if (appointment) {
        await onUpdate(appointment, draftToAppointmentChanges(draft, allowDoubleBook));
      } else if (!savedThisAttempt) {
        await onCreate(draftToBookInput(draft, allowDoubleBook));
        savedThisAttempt = true;
        setAppointmentSaved(true);
      }
      if (inboundReferral) {
        await correspondenceApi.createInboundReferral(inboundReferral);
      }
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!allowDoubleBook && (await confirmDoubleBookAndRetry(err, () => save(true)))) {
        return;
      }
      setError(savedThisAttempt && inboundReferral
        ? `Appointment saved, but the referred-by record was not saved: ${message}`
        : message);
    } finally {
      setSaving(false);
    }
  }

  async function transition(status: OdosAppointmentStatus) {
    if (!appointment) {
      setDraft((current) => ({ ...current, status }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSetStatus(appointment, status);
      setDraft((current) => ({ ...current, status }));
      if (status === "cancelled") {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function updateDateTime(date: string, time: string) {
    setDraft((current) => withDateAndTime(current, date, time, timezoneOffset));
  }

  function updateVisitType(code: string) {
    const entry = visibleVisitTypes.find((visitType) => visitTypeCode(visitType) === code);
    const durationMinutes = visitTypeDurationMinutes(entry ?? ({} as HealthcareService));
    if (durationMinutes !== undefined) {
      setDurationCustom(!isDurationPreset(durationMinutes));
    }
    setDraft((current) => ({
      ...current,
      visitTypeCode: code,
      durationMinutes: durationMinutes ?? current.durationMinutes,
    }));
  }

  function selectCoverage(kind: "vision" | "medical", value: string) {
    const coverages = kind === "vision" ? visionCoverages : medicalCoverages;
    const setOther = kind === "vision" ? setVisionOther : setMedicalOther;
    const referenceKey = kind === "vision" ? "visionCoverageReference" : "medicalCoverageReference";
    const displayKey = kind === "vision" ? "visionCoverageDisplay" : "medicalCoverageDisplay";
    if (value === "other") {
      setOther(true);
      setDraft((current) => ({ ...current, [referenceKey]: "", [displayKey]: "" }));
      return;
    }
    setOther(false);
    const coverage = coverages.find((candidate) => coverageReference(candidate) === value);
    setDraft((current) => ({
      ...current,
      [referenceKey]: coverage ? coverageReference(coverage) : "",
      [displayKey]: coverage ? appointmentCoverageDisplay(coverage) : "",
    }));
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
      <section className="max-h-[92vh] w-full max-w-5xl overflow-y-auto border border-white/15 bg-[#10111c] text-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <div className="text-xs uppercase text-white/45">
              {appointment ? "Appointment Details" : "New Appointment"}
            </div>
            <h2 className="text-lg font-semibold">
              {draft.nonPatient ? draft.description || "Non-patient block" : draft.patient?.display ?? "Select patient"}
            </h2>
          </div>
          <button className="scheduler-icon-button" type="button" aria-label="Close" onClick={onClose}>
            x
          </button>
        </header>

        <div className="grid gap-4 p-4 lg:grid-cols-[1fr_280px]">
          <div className="grid gap-4">
            {error && (
              <div className="border border-red-400/40 bg-red-950/50 px-3 py-2 text-sm text-red-100">
                {error}
              </div>
            )}
            {createDisabled && (
              <div className="border border-amber-300/35 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
                No scheduler resources are loaded for this appointment.
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-2">
              <label className="scheduler-field">
                <span>Service Type</span>
                <select
                  className="scheduler-input"
                  aria-label="Service Type"
                  value={draft.visitTypeCode}
                  onChange={(event) => updateVisitType(event.target.value)}
                >
                  {visibleVisitTypes.map((visitType) => {
                    const code = visitTypeCode(visitType);
                    return code ? (
                      <option key={code} value={code}>
                        {visitType.name ?? code}
                      </option>
                    ) : null;
                  })}
                </select>
              </label>
              <div className="scheduler-field">
                <label htmlFor="appointment-duration-preset">Duration</label>
                <select
                  id="appointment-duration-preset"
                  className="scheduler-input"
                  aria-label="Duration preset"
                  value={durationCustom ? "custom" : draft.durationMinutes}
                  onChange={(event) => {
                    if (event.target.value === "custom") {
                      setDurationCustom(true);
                      return;
                    }
                    setDurationCustom(false);
                    setDraft((current) => ({
                      ...current,
                      durationMinutes: Number(event.target.value),
                    }));
                  }}
                >
                  {DURATION_PRESETS.map((minutes) => (
                    <option key={minutes} value={minutes}>{minutes === 60 ? "1 hr" : `${minutes} min`}</option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
                {durationCustom && (
                  <input
                    className="scheduler-input"
                    aria-label="Custom duration minutes"
                    min={1}
                    type="number"
                    value={draft.durationMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        durationMinutes: Number(event.target.value),
                      }))
                    }
                  />
                )}
              </div>
              <label className="scheduler-field">
                <span>Date</span>
                <input
                  className="scheduler-input"
                  type="date"
                  value={dateInputValue(draft.start, timezoneOffset)}
                  onChange={(event) => updateDateTime(event.target.value, timeInputValue(draft.start, timezoneOffset))}
                />
              </label>
              <label className="scheduler-field">
                <span>Time</span>
                <input
                  className="scheduler-input"
                  type="time"
                  value={timeInputValue(draft.start, timezoneOffset)}
                  onChange={(event) => updateDateTime(dateInputValue(draft.start, timezoneOffset), event.target.value)}
                />
              </label>
            </div>

            {!appointment && !draft.nonPatient && (
              <fieldset className="border border-white/10 p-3">
                <legend className="px-1 text-xs uppercase text-white/45">Referral intake</legend>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="scheduler-field">
                    <span>Referred by</span>
                    <input
                      className="scheduler-input"
                      aria-label="Referred by"
                      list="appointment-referrer-options"
                      placeholder="Search directory or enter a name"
                      value={referrerQuery}
                      onChange={(event) => setReferrerQuery(event.target.value)}
                    />
                    <datalist id="appointment-referrer-options">
                      {referrerMatches.map((consultant) => (
                        <option key={consultant.reference} value={consultant.display} />
                      ))}
                    </datalist>
                  </label>
                  <label className="scheduler-field">
                    <span>Reason for referral</span>
                    <input
                      className="scheduler-input"
                      aria-label="Reason for referral"
                      value={referralReason}
                      onChange={(event) => setReferralReason(event.target.value)}
                    />
                  </label>
                </div>
              </fieldset>
            )}

            <div className="grid gap-3 md:grid-cols-2">
              <AppointmentCoverageField
                kind="vision"
                patientSelected={Boolean(draft.patient)}
                loading={coverageLoading}
                loadError={coverageError}
                coverages={visionCoverages}
                other={visionOther}
                value={coverageSelectValue(draft, visionCoverages, "vision", visionOther)}
                display={draft.visionCoverageDisplay}
                onSelect={(value) => selectCoverage("vision", value)}
                onDisplayChange={(value) =>
                  setDraft((current) => ({ ...current, visionCoverageReference: "", visionCoverageDisplay: value }))
                }
              />
              <AppointmentCoverageField
                kind="medical"
                patientSelected={Boolean(draft.patient)}
                loading={coverageLoading}
                loadError={coverageError}
                coverages={medicalCoverages}
                other={medicalOther}
                value={coverageSelectValue(draft, medicalCoverages, "medical", medicalOther)}
                display={draft.medicalCoverageDisplay}
                onSelect={(value) => selectCoverage("medical", value)}
                onDisplayChange={(value) =>
                  setDraft((current) => ({ ...current, medicalCoverageReference: "", medicalCoverageDisplay: value }))
                }
              />
            </div>

            <fieldset className="border border-white/10 p-3">
              <legend className="px-1 text-xs uppercase text-white/45">Resource(s)</legend>
              <div className="grid gap-2 md:grid-cols-2">
                {resources.map((resource) => {
                  const reference = scheduleReference(resource);
                  if (!reference) return null;
                  const checked = draft.resourceScheduleReferences.includes(reference);
                  return (
                    <label key={reference} className="flex items-center gap-2 text-sm text-white/75">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            resourceScheduleReferences: event.target.checked
                              ? [...current.resourceScheduleReferences, reference]
                              : current.resourceScheduleReferences.filter((value) => value !== reference),
                          }))
                        }
                      />
                      <span>{resourceDisplay(resource)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="scheduler-field">
                <span>Confirmation Status</span>
                <select
                  className="scheduler-input"
                  value={draft.confirmation}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, confirmation: event.target.value as AppointmentConfirmationStatus }))
                  }
                >
                  {APPOINTMENT_CONFIRMATION_STATUSES.map((status) => (
                    <option key={status.code} value={status.code}>
                      {status.display}
                    </option>
                  ))}
                </select>
              </label>
              <label className="scheduler-field">
                <span>Appointment Status</span>
                <select
                  className="scheduler-input"
                  value={draft.status}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, status: event.target.value as OdosAppointmentStatus }))
                  }
                >
                  {ODOS_APPOINTMENT_STATUSES.map((status) => (
                    <option key={status.code} value={status.code}>
                      {status.display}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <button className="scheduler-button" type="button" onClick={() => void transition("checked-in")}>
                Check In
              </button>
              <button className="scheduler-button" type="button" onClick={() => void transition("checked-out")}>
                Check Out
              </button>
              <button className="scheduler-button" type="button" onClick={() => void transition("no-show")}>
                No Show
              </button>
              <button className="scheduler-button" type="button" onClick={() => void transition("cancelled")}>
                Cancel
              </button>
            </div>

            <label className="scheduler-field">
              <span>Notes</span>
              <textarea
                className="scheduler-input min-h-24 py-2"
                value={draft.notes}
                onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
              />
            </label>
          </div>

          <aside className="grid content-start gap-3 border border-white/10 bg-black/20 p-3">
            <label className="flex items-center gap-2 text-sm text-white/75">
              <input
                type="checkbox"
                checked={draft.nonPatient}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, nonPatient: event.target.checked }))
                }
              />
              <span>Non-patient block</span>
            </label>

            {draft.nonPatient ? (
              <label className="scheduler-field">
                <span>Description</span>
                <input
                  className="scheduler-input"
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </label>
            ) : (
              <div className="grid gap-2">
                <div className="text-xs uppercase text-white/45">Patient</div>
                <div className="border border-white/10 bg-black/20 p-2 text-sm">
                  {draft.patient?.display ?? draft.patient?.reference ?? "No patient selected"}
                </div>
                <button
                  className="scheduler-button"
                  type="button"
                  onClick={() => setPatientQueryOpen((open) => !open)}
                >
                  Change Patient
                </button>
                {patientQueryOpen && (
                  <PatientSearch
                    onSelect={(patient) => {
                      if (!patient.id) return;
                      setDraft((current) => ({
                        ...current,
                        patient: { reference: `Patient/${patient.id}`, display: patientName(patient) },
                        nonPatient: false,
                      }));
                      setPatientQueryOpen(false);
                    }}
                  />
                )}
              </div>
            )}

            <label className="flex items-center gap-2 text-sm text-white/75">
              <input
                type="checkbox"
                checked={draft.urgent}
                onChange={(event) => setDraft((current) => ({ ...current, urgent: event.target.checked }))}
              />
              <span>Urgent</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-white/75">
              <input
                type="checkbox"
                checked={draft.followUp}
                onChange={(event) => setDraft((current) => ({ ...current, followUp: event.target.checked }))}
              />
              <span>Follow-Up</span>
            </label>

            <div className="border-t border-white/10 pt-3 text-xs text-white/50">
              <div>Created: {appointment?.created ?? "pending"}</div>
              <div>Updated: {appointment?.meta?.lastUpdated ?? "pending"}</div>
            </div>
            <button className="scheduler-button" type="button" disabled>
              View History
            </button>
          </aside>
        </div>

        <footer className="flex justify-end gap-2 border-t border-white/10 px-4 py-3">
          <button className="scheduler-button" type="button" onClick={onClose}>
            Close
          </button>
          <button className="scheduler-button" type="button" disabled={saving || createDisabled} onClick={() => void save()}>
            Save
          </button>
        </footer>
      </section>
    </div>
  );
}

function AppointmentCoverageField({
  kind,
  patientSelected,
  loading,
  loadError,
  coverages,
  other,
  value,
  display,
  onSelect,
  onDisplayChange,
}: {
  kind: "vision" | "medical";
  patientSelected: boolean;
  loading: boolean;
  loadError: string | null;
  coverages: Coverage[];
  other: boolean;
  value: string;
  display: string;
  onSelect: (value: string) => void;
  onDisplayChange: (value: string) => void;
}) {
  const label = `${kind === "vision" ? "Vision" : "Medical"} Insurance`;
  if (!patientSelected || loadError) {
    return (
      <label className="scheduler-field">
        <span>{label}</span>
        <input
          className="scheduler-input"
          aria-label={label}
          value={display}
          placeholder="none"
          onChange={(event) => onDisplayChange(event.target.value)}
        />
        {loadError && kind === "vision" && <small className="text-amber-200/60">{loadError}</small>}
      </label>
    );
  }
  if (loading) {
    return (
      <label className="scheduler-field">
        <span>{label}</span>
        <select className="scheduler-input" aria-label={label} disabled value="loading">
          <option value="loading">Loading patient coverages…</option>
        </select>
      </label>
    );
  }
  return (
    <div className="scheduler-field">
      <label htmlFor={`appointment-${kind}-coverage`}>{label}</label>
      <select
        id={`appointment-${kind}-coverage`}
        className="scheduler-input"
        aria-label={label}
        value={value}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="none">None</option>
        {coverages.map((coverage) => (
          <option key={coverageReference(coverage)} value={coverageReference(coverage)}>
            {appointmentCoverageDisplay(coverage)}
          </option>
        ))}
        <option value="other">Other…</option>
      </select>
      {other && (
        <input
          className="scheduler-input"
          aria-label={`Other ${label}`}
          value={display}
          placeholder="Enter plan display"
          onChange={(event) => onDisplayChange(event.target.value)}
        />
      )}
    </div>
  );
}

function isDurationPreset(minutes: number): minutes is (typeof DURATION_PRESETS)[number] {
  return DURATION_PRESETS.includes(minutes as (typeof DURATION_PRESETS)[number]);
}

function relevantCoverages(
  coverages: Coverage[] | null,
  kind: "vision" | "medical",
): Coverage[] {
  return (coverages ?? []).filter((coverage) => coverage.id && coverageType(coverage) === kind);
}

function coverageReference(coverage: Coverage): string {
  return `Coverage/${coverage.id}`;
}

function appointmentCoverageDisplay(coverage: Coverage): string {
  const carrier = coverage.payor[0]?.display ?? coverage.payor[0]?.reference ?? "";
  const plan = coveragePlanName(coverage);
  return [carrier, plan].filter(Boolean).join(" · ") || coverageReference(coverage);
}

function coverageSelectValue(
  draft: AppointmentModalDraft,
  coverages: Coverage[],
  kind: "vision" | "medical",
  other: boolean,
): string {
  if (other) return "other";
  const reference = kind === "vision" ? draft.visionCoverageReference : draft.medicalCoverageReference;
  const display = kind === "vision" ? draft.visionCoverageDisplay : draft.medicalCoverageDisplay;
  const match = coverages.find((coverage) =>
    coverageReference(coverage) === reference || appointmentCoverageDisplay(coverage) === display,
  );
  return match ? coverageReference(match) : display ? "other" : "none";
}

function needsOtherCoverage(
  draft: AppointmentModalDraft,
  coverages: Coverage[],
  kind: "vision" | "medical",
): boolean {
  const relevant = relevantCoverages(coverages, kind);
  const reference = kind === "vision" ? draft.visionCoverageReference : draft.medicalCoverageReference;
  const display = kind === "vision" ? draft.visionCoverageDisplay : draft.medicalCoverageDisplay;
  return Boolean(display) && !relevant.some((coverage) =>
    coverageReference(coverage) === reference || appointmentCoverageDisplay(coverage) === display,
  );
}

function inboundReferralInput(
  draft: AppointmentModalDraft,
  resources: Schedule[],
  referrerQuery: string,
  reasonText: string,
  consultants: ReferralConsultant[],
): Parameters<ReferralApi["createInboundReferral"]>[0] | Error {
  const patientId = draft.patient?.reference?.match(/^Patient\/([A-Za-z0-9.-]{1,64})$/)?.[1];
  if (!patientId) return new Error("Select a patient before capturing who referred them.");
  const reason = reasonText.trim();
  if (!reason) return new Error("Enter the reason for the inbound referral.");
  const selectedSchedules = new Set(draft.resourceScheduleReferences);
  const performerReference = resources
    .filter((resource) => {
      const reference = scheduleReference(resource);
      return reference ? selectedSchedules.has(reference) : false;
    })
    .flatMap((resource) => resource.actor ?? [])
    .map((actor) => actor.reference)
    .find((reference): reference is string =>
      Boolean(reference?.match(/^(Practitioner|PractitionerRole)\/[A-Za-z0-9.-]{1,64}$/)));
  if (!performerReference) {
    return new Error("Select a provider resource before capturing an inbound referral.");
  }
  const referrerDisplay = referrerQuery.trim();
  const match = consultants.find(
    (consultant) => consultant.display.localeCompare(referrerDisplay, undefined, {
      sensitivity: "accent",
    }) === 0,
  );
  return {
    patientId,
    ...(match ? { referrerReference: match.reference } : {}),
    referrerDisplay,
    performerReference,
    captureSource: "front-desk",
    reasonText: reason,
  };
}

function emptyDraft(timezoneOffset: string): AppointmentModalDraft {
  return {
    nonPatient: false,
    description: "",
    visitTypeCode: "",
    resourceScheduleReferences: [],
    start: `1970-01-01T09:00:00${timezoneOffset}`,
    durationMinutes: 30,
    status: "scheduled",
    confirmation: "not-confirmed",
    visionCoverageReference: "",
    visionCoverageDisplay: "",
    medicalCoverageReference: "",
    medicalCoverageDisplay: "",
    notes: "",
    urgent: false,
    followUp: false,
  };
}
