import React, { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Patient } from "@medplum/fhirtypes";
import {
  fetchPatientOverview,
  fetchStickyNoteHistory,
  saveStickyNote,
  type PatientOverviewMedication,
  type PatientOverviewPayload,
  type StickyNoteHistoryEntry,
  type VisitLedgerFilter,
} from "../lib/patient-overview";
import { useViewState } from "../lib/view-state";
import { CLINIC_PATH } from "./DeskHome";
import { PinnedOfficeNote } from "../components/OfficeChannel";
import { BalanceChips } from "../components/commercial/BalanceChips";
import { CreditBankDepositSheet } from "../components/commercial/CreditBankDepositSheet";
import { SaleSheet } from "../components/commercial/SaleSheet";

interface PatientOverviewApi {
  fetchOverview: typeof fetchPatientOverview;
  fetchHistory: typeof fetchStickyNoteHistory;
  saveNote: typeof saveStickyNote;
}

const defaultPatientOverviewApi: PatientOverviewApi = {
  fetchOverview: fetchPatientOverview,
  fetchHistory: fetchStickyNoteHistory,
  saveNote: saveStickyNote,
};

export function PatientOverview({
  patient,
  initialOverview,
  api = defaultPatientOverviewApi,
}: {
  patient: Patient;
  initialOverview?: PatientOverviewPayload;
  api?: PatientOverviewApi;
}) {
  const setView = useViewState((state) => state.setView);
  const [overview, setOverview] = useState(initialOverview);
  const [filter, setFilter] = useState<VisitLedgerFilter>("all");
  const [diagnosisFilter, setDiagnosisFilter] = useState("");
  const [error, setError] = useState<string>();
  const [loadingLedger, setLoadingLedger] = useState(!initialOverview);
  const [editing, setEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState(initialOverview?.stickyNote?.text ?? "");
  const [savingNote, setSavingNote] = useState(false);
  const [history, setHistory] = useState<StickyNoteHistoryEntry[]>();
  const [historyError, setHistoryError] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sellingPackage, setSellingPackage] = useState(false);
  const [depositingCreditBank, setDepositingCreditBank] = useState(false);
  const [packageRevision, setPackageRevision] = useState(0);
  const requestIdRef = useRef(0);
  const historyRequestIdRef = useRef(0);

  useEffect(() => {
    if (initialOverview) return;
    if (!patient.id) {
      setLoadingLedger(false);
      setError("Patient id is unavailable.");
      return;
    }
    setLoadingLedger(true);
    setError(undefined);
    const requestId = ++requestIdRef.current;
    api.fetchOverview(patient.id)
      .then((value) => {
        if (requestId !== requestIdRef.current) return;
        setOverview(value);
        setNoteDraft(value.stickyNote?.text ?? "");
      })
      .catch((reason) => requestId === requestIdRef.current && setError(messageOf(reason)))
      .finally(() => requestId === requestIdRef.current && setLoadingLedger(false));
    return () => {
      if (requestId === requestIdRef.current) requestIdRef.current += 1;
    };
  }, [api, initialOverview, patient.id]);

  const name = patientName(patient);
  const age = patientAge(patient.birthDate);
  const chartNumber = patient.identifier?.find((identifier) => identifier.value)?.value;
  const demographics = [age !== undefined ? String(age) : undefined, sexLabel(patient.gender)].filter(Boolean).join(" · ");
  const selectedDiagnosis = useMemo(() => overview?.diagnosisChoices.find((choice) => `${choice.system}|${choice.code}` === diagnosisFilter), [overview, diagnosisFilter]);

  async function applyFilter(nextFilter: VisitLedgerFilter, diagnosis?: typeof selectedDiagnosis | null) {
    if (!patient.id) return;
    const activeDiagnosis = diagnosis === undefined ? selectedDiagnosis : diagnosis ?? undefined;
    setFilter(nextFilter);
    setLoadingLedger(true);
    setError(undefined);
    const requestId = ++requestIdRef.current;
    try {
      const value = await api.fetchOverview(patient.id, {
        filter: nextFilter,
        ...(activeDiagnosis ? { diagnosisSystem: activeDiagnosis.system, diagnosisCode: activeDiagnosis.code } : {}),
      });
      if (requestId === requestIdRef.current) {
        setOverview((current) => current?.stickyNote ? { ...value, stickyNote: current.stickyNote } : value);
      }
    } catch (reason) {
      if (requestId === requestIdRef.current) setError(messageOf(reason));
    } finally {
      if (requestId === requestIdRef.current) setLoadingLedger(false);
    }
  }

  async function commitNote() {
    if (!patient.id) return;
    setSavingNote(true);
    setError(undefined);
    try {
      const stickyNote = await api.saveNote(patient.id, noteDraft);
      setOverview((current) => current ? { ...current, stickyNote } : current);
      setEditing(false);
      historyRequestIdRef.current += 1;
      setHistory(undefined);
      setHistoryError(undefined);
      setHistoryOpen(false);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSavingNote(false);
    }
  }

  async function showHistory() {
    if (!patient.id) return;
    setHistoryOpen(true);
    if (history) return;
    setHistoryError(undefined);
    const requestId = ++historyRequestIdRef.current;
    try {
      const entries = await api.fetchHistory(patient.id);
      if (requestId === historyRequestIdRef.current) setHistory(entries);
    } catch (reason) {
      if (requestId === historyRequestIdRef.current) setHistoryError(messageOf(reason));
    }
  }

  return (
    <main className="odos-patient-overview">
      <div className="odos-ambient" aria-hidden="true" />
      <section className="odos-overview-body">
        <nav className="odos-overview-crumb" aria-label="Breadcrumb">
          <a href={CLINIC_PATH} onClick={navigateWithinApp}>Clinic</a><span>›</span><span>{name}</span>
        </nav>
        <div className="odos-overview-head">
          <h1>{name}</h1>
          <div className="odos-overview-meta">
            <span>{demographics || "Age/sex not recorded"}</span>
            <span>DOB <b>{patient.birthDate ? localDate(patient.birthDate) : "not recorded"}</b></span>
            <span>Chart <b>{chartNumber ? `#${chartNumber}` : "not recorded"}</b></span>
            <span>{overview?.insurance.length ? overview.insurance.join(" · ") : overview?.unavailable?.insurance ?? "Insurance not recorded"}</span>
          </div>
          {patient.id && <BalanceChips patientReference={`Patient/${patient.id}`} revision={packageRevision} />}
          <div className="odos-overview-actions">
            <button type="button" className="odos-overview-button" onClick={() => setDepositingCreditBank(true)}>Deposit Credit Bank</button>
            <button type="button" className="odos-overview-button" onClick={() => setSellingPackage(true)}>Sell package</button>
            <button type="button" className="odos-overview-button is-primary" onClick={() => patient.id && setView({ kind: "director", patientId: patient.id })}>Start today&apos;s visit →</button>
          </div>
          <PinnedOfficeNote patientId={patient.id} />
        </div>

        <section className="odos-sticky-note" aria-label="Patient sticky note">
          <span className="odos-sticky-tag">Sticky note</span>
          {editing ? (
            <textarea aria-label="Sticky note text" value={noteDraft} maxLength={2000} onChange={(event) => setNoteDraft(event.target.value)} />
          ) : (
            <span className={overview?.stickyNote?.text ? "odos-sticky-text" : "odos-sticky-empty"}>{overview?.stickyNote?.text || "No sticky note recorded"}</span>
          )}
          {!editing && <span className="odos-sticky-stamp">{overview?.stickyNote?.editedAt ? `edited ${shortDate(overview.stickyNote.editedAt)}` : "No edit history"}</span>}
          {editing ? (
            <React.Fragment>
              <button type="button" disabled={savingNote || !noteDraft.trim()} onClick={commitNote}>{savingNote ? "Saving…" : "Save"}</button>
              <button type="button" disabled={savingNote} onClick={() => { setEditing(false); setNoteDraft(overview?.stickyNote?.text ?? ""); }}>Cancel</button>
            </React.Fragment>
          ) : (
            <React.Fragment>
              <button type="button" onClick={() => setEditing(true)}>Edit</button>
              <button type="button" aria-expanded={historyOpen} aria-controls="patient-sticky-history" onClick={showHistory}>History</button>
            </React.Fragment>
          )}
        </section>

        {historyOpen && (
          <section id="patient-sticky-history" className="odos-sticky-history" aria-label="Sticky note history">
            <div><h2>Sticky note history</h2><button type="button" onClick={() => setHistoryOpen(false)}>Close</button></div>
            {!history && !historyError && <p>Loading version history…</p>}
            {historyError && <p className="odos-overview-error" role="alert">{historyError}</p>}
            {history?.length === 0 && <p>No sticky-note versions recorded.</p>}
            {history?.map((entry) => (
              <article key={entry.versionId}>
                <p>{entry.text || "Blank note"}</p>
                <small>Version {entry.versionId} · {entry.editedAt ? shortDateTime(entry.editedAt) : "time not recorded"} · {entry.editedBy ?? "author not recorded"}</small>
              </article>
            ))}
          </section>
        )}

        {error && <p className="odos-overview-error" role="alert">{error}</p>}
        {!overview && !error && <p className="odos-overview-loading">Loading patient overview…</p>}
        {overview && (
          <div className="odos-overview-grid">
            <PatientSnapshot snapshot={overview.snapshot} medicationOrdersUnavailable={overview.unavailable?.medicationOrders} />
            <section className="odos-overview-card odos-ledger-card">
              <span className="odos-overview-edge" />
              <div className="odos-overview-kicker">Visit ledger <span>every visit · its diagnoses · at a glance</span></div>
              <div className="odos-ledger-filters">
                <FilterButton active={filter === "all"} onClick={() => applyFilter("all")}>All visits</FilterButton>
                <FilterButton active={filter === "eye-exams"} onClick={() => applyFilter("eye-exams")}>Eye exams</FilterButton>
                <FilterButton active={filter === "office-visits"} onClick={() => applyFilter("office-visits")}>Office visits</FilterButton>
                <label>By diagnosis
                  <select value={diagnosisFilter} onChange={(event) => {
                    const value = event.target.value;
                    setDiagnosisFilter(value);
                    const diagnosis = overview.diagnosisChoices.find((choice) => `${choice.system}|${choice.code}` === value);
                    void applyFilter(filter, diagnosis ?? null);
                  }}>
                    <option value="">All diagnoses</option>
                    {overview.diagnosisChoices.map((choice) => <option key={`${choice.system}|${choice.code}`} value={`${choice.system}|${choice.code}`}>{choice.name}</option>)}
                  </select>
                </label>
                <span className="odos-ledger-query-note">Live FHIR query</span>
              </div>
              {loadingLedger && <p className="odos-overview-loading">Refreshing visit ledger…</p>}
              {!loadingLedger && overview.visits.length === 0 && <p className="odos-overview-none">No matching visits recorded</p>}
              {!loadingLedger && overview.visits.map((visit) => (
                <article className="odos-visit-row" key={visit.encounterId}>
                  <time>{visit.date ? monthDay(visit.date) : "Date not recorded"}<small>{visit.date ? yearOf(visit.date) : ""}</small></time>
                  <div className="odos-visit-head">
                    <span className="odos-visit-type">{visit.visitType}</span>
                    <span>{visit.provider ?? "Provider not recorded"} · {visit.facility ?? "Facility not recorded"}</span>
                    <span className={visit.status === "Final" ? "is-final" : "is-preliminary"}>{visit.status}{visit.status === "Final" ? " ✓" : ""}</span>
                  </div>
                  <div className="odos-dx-row">
                    {visit.diagnoses.length === 0 && <span className="odos-overview-none">No confirmed diagnoses recorded for this visit</span>}
                    {visit.diagnoses.map((diagnosis) => (
                      <button type="button" className="odos-dx-chip" key={diagnosis.conditionId} onClick={() => setView({ kind: "encounter", patientId: patient.id ?? "", encounterId: diagnosis.encounterId })}>
                        {diagnosis.name}{diagnosis.laterality && <small>{diagnosis.laterality}</small>}{diagnosis.code && <code>{diagnosis.code}</code>}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </section>
          </div>
        )}
        {sellingPackage && patient.id && (
          <SaleSheet
            patientReference={`Patient/${patient.id}`}
            patientName={name}
            onClose={() => setSellingPackage(false)}
            onSold={() => setPackageRevision((current) => current + 1)}
          />
        )}
        {depositingCreditBank && patient.id && (
          <CreditBankDepositSheet
            patientReference={`Patient/${patient.id}`}
            patientName={name}
            onClose={() => setDepositingCreditBank(false)}
            onDeposited={() => setPackageRevision((current) => current + 1)}
          />
        )}
      </section>
    </main>
  );
}

function PatientSnapshot({ snapshot, medicationOrdersUnavailable }: { snapshot: PatientOverviewPayload["snapshot"]; medicationOrdersUnavailable?: string }) {
  return (
    <section className="odos-overview-card odos-snapshot-card">
      <span className="odos-overview-edge" />
      <div className="odos-overview-kicker">Patient snapshot</div>
      <SnapshotList title="Ocular history" rows={snapshot.ocularHistory.map((row) => ({ label: row.name, detail: row.laterality }))} />
      <SnapshotList title="Ocular surgical history" rows={snapshot.ocularSurgicalHistory.map((row) => ({ label: row.name, detail: row.date ? shortDate(row.date) : undefined }))} />
      <SnapshotList title="Medical conditions" rows={snapshot.medicalConditions.map((row) => ({ label: row.name }))} />
      <MedicationList title="Ophthalmic medications" rows={snapshot.ophthalmicMedications} unavailable={medicationOrdersUnavailable} />
      <MedicationList title="Systemic medications" rows={snapshot.systemicMedications} unavailable={medicationOrdersUnavailable} />
      <SnapshotList title="Social / smoking history" rows={snapshot.socialHistory.map((label) => ({ label }))} />
    </section>
  );
}

function SnapshotList({ title, rows }: { title: string; rows: Array<{ label: string; detail?: string }> }) {
  return <section><h2>{title}</h2>{rows.length ? <ul>{rows.map((row, index) => <li key={`${row.label}-${index}`}>{row.label}{row.detail && <small>{row.detail}</small>}</li>)}</ul> : <p className="odos-overview-none">None recorded</p>}</section>;
}

function MedicationList({ title, rows, unavailable }: { title: string; rows: PatientOverviewMedication[]; unavailable?: string }) {
  return <section><h2>{title}</h2>{rows.length ? <ul>{rows.map((row, index) => <li key={row.id ?? `${row.name}-${index}`}>{row.name}{row.sig && <small>{row.sig}</small>}</li>)}</ul> : !unavailable ? <p className="odos-overview-none">None recorded</p> : null}{unavailable && <p className="odos-overview-none">{unavailable}</p>}</section>;
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick(): void; children: string }) {
  return <button type="button" className={active ? "is-active" : ""} onClick={onClick}>{children}</button>;
}

function patientName(patient: Patient): string {
  const name = patient.name?.find((candidate) => candidate.use === "usual") ?? patient.name?.[0];
  return [name?.given?.join(" "), name?.family].filter(Boolean).join(" ") || "Patient name not recorded";
}

function patientAge(birthDate: string | undefined): number | undefined {
  if (!birthDate) return undefined;
  const birth = new Date(`${birthDate}T00:00:00`);
  if (!Number.isFinite(birth.getTime())) return undefined;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age -= 1;
  return age;
}

function sexLabel(gender: Patient["gender"]): string | undefined {
  if (gender === "female") return "F";
  if (gender === "male") return "M";
  if (gender === "other") return "X";
  if (gender === "unknown") return "U";
  return undefined;
}

function localDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { year: "2-digit", month: "numeric", day: "numeric" }).format(new Date(value));
}

function shortDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function monthDay(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" }).format(new Date(value));
}

function yearOf(value: string): string {
  return new Intl.DateTimeFormat(undefined, { year: "numeric" }).format(new Date(value));
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Patient overview unavailable.";
}

function navigateWithinApp(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.history.pushState({}, "", event.currentTarget.href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
