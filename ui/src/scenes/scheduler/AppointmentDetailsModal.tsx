import type { Appointment, HealthcareService, Patient, Schedule } from "@medplum/fhirtypes";
import { useEffect, useMemo, useState } from "react";
import { fhir } from "../../lib/fhir";
import {
  APPOINTMENT_CONFIRMATION_STATUSES,
  OSOD_APPOINTMENT_STATUSES,
  resourceDisplay,
  scheduleReference,
  visitTypeCode,
  visitTypeDurationMinutes,
  visibleSchedulingVisitTypes,
  type AppointmentConfirmationStatus,
  type ClinicMode,
  type OsodAppointmentStatus,
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
    status: OsodAppointmentStatus,
    deps?: SchedulingWriteDeps,
  ) => Promise<void>;
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

  useEffect(() => {
    setDraft(appointment ? appointmentModalDraftFromAppointment(appointment, resources) : fallbackDraft ?? emptyDraft(timezoneOffset));
    setError(null);
  }, [appointment?.id, Boolean(fallbackDraft)]);

  const visibleVisitTypes = useMemo(
    () => visibleSchedulingVisitTypes(visitTypes, clinicMode),
    [visitTypes, clinicMode],
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
    setSaving(true);
    setError(null);
    try {
      if (appointment) {
        await onUpdate(appointment, draftToAppointmentChanges(draft, allowDoubleBook));
      } else {
        await onCreate(draftToBookInput(draft, allowDoubleBook));
      }
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!allowDoubleBook && (await confirmDoubleBookAndRetry(err, () => save(true)))) {
        return;
      }
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  async function transition(status: OsodAppointmentStatus) {
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
    setDraft((current) => ({
      ...current,
      visitTypeCode: code,
      durationMinutes: visitTypeDurationMinutes(entry ?? ({} as HealthcareService)) ?? current.durationMinutes,
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
              <label className="scheduler-field">
                <span>Duration</span>
                <input
                  className="scheduler-input"
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
              </label>
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

            <div className="grid gap-3 md:grid-cols-2">
              <label className="scheduler-field">
                <span>Vision Insurance</span>
                <input
                  className="scheduler-input"
                  value={draft.visionCoverageDisplay}
                  placeholder="none"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, visionCoverageDisplay: event.target.value }))
                  }
                />
              </label>
              <label className="scheduler-field">
                <span>Medical Insurance</span>
                <input
                  className="scheduler-input"
                  value={draft.medicalCoverageDisplay}
                  placeholder="none"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, medicalCoverageDisplay: event.target.value }))
                  }
                />
              </label>
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
                    setDraft((current) => ({ ...current, status: event.target.value as OsodAppointmentStatus }))
                  }
                >
                  {OSOD_APPOINTMENT_STATUSES.map((status) => (
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
                      setDraft((current) => ({ ...current, patient, nonPatient: false }));
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

function PatientSearch({
  onSelect,
}: {
  onSelect: (patient: { reference: string; display?: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setPatients([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      async function searchPatients() {
        setLoading(true);
        setError(null);
        try {
          const bundle = await fhir.search<Patient>("Patient", { name: trimmed, _count: "20" });
          if (!cancelled) {
            setPatients((bundle.entry ?? []).flatMap((entry) => (entry.resource ? [entry.resource] : [])));
          }
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setPatients([]);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
      void searchPatients();
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query]);

  return (
    <div className="grid gap-2">
      <input
        className="scheduler-input"
        value={query}
        placeholder="Search patient"
        onChange={(event) => setQuery(event.target.value)}
      />
      {loading && <div className="text-xs text-white/45">Searching</div>}
      {error && <div className="text-xs text-red-200">{error}</div>}
      <div className="grid max-h-44 gap-1 overflow-y-auto">
        {patients.map((patient) => (
          <button
            key={patient.id}
            className="border border-white/10 bg-white/[0.04] px-2 py-1 text-left text-sm hover:bg-white/[0.1]"
            type="button"
            disabled={!patient.id}
            onClick={() =>
              patient.id &&
              onSelect({ reference: `Patient/${patient.id}`, display: patientName(patient) })
            }
          >
            <span className="block font-semibold">{patientName(patient)}</span>
            <span className="text-xs text-white/45">DOB {patient.birthDate ?? "unknown"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
