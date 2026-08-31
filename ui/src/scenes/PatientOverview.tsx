import React, { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Patient, ServiceRequest } from "@medplum/fhirtypes";
import {
  fetchPatientOverview,
  fetchPatientOverviewVisitDetail,
  fetchStickyNoteHistory,
  saveStickyNote,
  type PatientOverviewBillingWeather,
  type PatientOverviewMedication,
  type PatientOverviewPayload,
  type PatientOverviewVisitDetail,
  type PatientOverviewVisitDetailGroup,
  type StickyNoteHistoryEntry,
  type VisitLedgerFilter,
} from "../lib/patient-overview";
import { useViewState } from "../lib/view-state";
import { overviewPanelDensity, type OverviewPanelId } from "../lib/card-registry";
import { useOptionalRole } from "../lib/role-context";
import { DEFAULT_ROLE } from "../lib/roles";
import { CLINIC_PATH } from "./DeskHome";
import { PinnedOfficeNote } from "../components/OfficeChannel";
import { SmsOptOutControl } from "../components/patient/SmsOptOutControl";
import { BalanceChips } from "../components/commercial/BalanceChips";
import { CreditBankDepositSheet } from "../components/commercial/CreditBankDepositSheet";
import { SaleSheet } from "../components/commercial/SaleSheet";
import { SeriesTrackerPanel, type SeriesTrackerPanelApi } from "../components/series-tracker/SeriesTrackerPanel";
import { PatientProgramPanels } from "../components/series-tracker/PatientProgramPanels";
import { LongitudinalImagingCard } from "../components/LongitudinalImagingCard";
import { OdosSelect } from "../components/inputs/OdosSelect";
import { StartExam } from "../components/StartExam";
import { PatientHistoryTimeline } from "../components/PatientHistoryTimeline";
import { fetchPatientHistory } from "../lib/audit-log";
import {
  findLatestActiveVisionPrescription,
  opticalOrderPath,
} from "../lib/optical-order";
import {
  referralApi,
  type ConsultReportArtifactResponse,
  type ReferralApi,
} from "../components/referral/referral-api";

interface PatientOverviewApi {
  fetchOverview: typeof fetchPatientOverview;
  fetchVisitDetail?: typeof fetchPatientOverviewVisitDetail;
  fetchHistory: typeof fetchStickyNoteHistory;
  saveNote: typeof saveStickyNote;
  findActiveRx?: typeof findLatestActiveVisionPrescription;
  fetchAuditHistory?: typeof fetchPatientHistory;
  seriesTracker?: SeriesTrackerPanelApi;
  correspondence?: Pick<ReferralApi, "listInboundReferrals" | "previewConsultReport">;
}

const OVERVIEW_LIST_LIMIT = 8;

const defaultPatientOverviewApi: PatientOverviewApi = {
  fetchOverview: fetchPatientOverview,
  fetchVisitDetail: fetchPatientOverviewVisitDetail,
  fetchHistory: fetchStickyNoteHistory,
  saveNote: saveStickyNote,
  findActiveRx: findLatestActiveVisionPrescription,
  fetchAuditHistory: fetchPatientHistory,
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
  const role = useOptionalRole()?.role ?? DEFAULT_ROLE;
  const density = (panelId: OverviewPanelId) => overviewPanelDensity(panelId, role);
  const isVisible = (panelId: OverviewPanelId) => density(panelId) !== "hidden";
  const [overview, setOverview] = useState(initialOverview);
  const [activePatientTab, setActivePatientTab] = useState<"overview" | "history">("overview");
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
  const [activeRxId, setActiveRxId] = useState<string | null>();
  const [rxError, setRxError] = useState<string>();
  const [correspondenceOpen, setCorrespondenceOpen] = useState(false);
  const [openVisitId, setOpenVisitId] = useState<string>();
  const [visitDetails, setVisitDetails] = useState<Record<string, PatientOverviewVisitDetail>>({});
  const [visitDetailLoading, setVisitDetailLoading] = useState<Record<string, boolean>>({});
  const [visitDetailErrors, setVisitDetailErrors] = useState<Record<string, string>>({});
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

  useEffect(() => {
    if (!patient.id || !api.findActiveRx) {
      setActiveRxId(null);
      setRxError(undefined);
      return;
    }
    let cancelled = false;
    setActiveRxId(undefined);
    setRxError(undefined);
    api.findActiveRx(patient.id)
      .then((rx) => {
        if (!cancelled) setActiveRxId(rx?.id ?? null);
      })
      .catch((reason) => {
        if (!cancelled) {
          setActiveRxId(null);
          setRxError(messageOf(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, patient.id]);

  const name = patientName(patient);
  const age = patientAge(patient.birthDate);
  const chartNumber = patient.identifier?.find((identifier) => identifier.value)?.value;
  const demographics = [age !== undefined ? String(age) : undefined, sexLabel(patient.gender)].filter(Boolean).join(" · ");
  const selectedDiagnosis = useMemo(() => overview?.diagnosisChoices.find((choice) => `${choice.system}|${choice.code}` === diagnosisFilter), [overview, diagnosisFilter]);
  const hasMedications = Boolean(overview?.snapshot.ophthalmicMedications.length || overview?.snapshot.systemicMedications.length);

  async function applyFilter(nextFilter: VisitLedgerFilter, diagnosis?: typeof selectedDiagnosis | null) {
    if (!patient.id) return;
    const activeDiagnosis = diagnosis === undefined ? selectedDiagnosis : diagnosis ?? undefined;
    setFilter(nextFilter);
    setLoadingLedger(true);
    setError(undefined);
    setOpenVisitId(undefined);
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

  async function toggleVisitDetail(encounterId: string) {
    if (openVisitId === encounterId) {
      setOpenVisitId(undefined);
      return;
    }
    setOpenVisitId(encounterId);
    if (visitDetails[encounterId] || visitDetailLoading[encounterId]) return;
    if (!patient.id || !api.fetchVisitDetail) {
      setVisitDetailErrors((current) => ({ ...current, [encounterId]: "Visit detail is unavailable." }));
      return;
    }
    setVisitDetailLoading((current) => ({ ...current, [encounterId]: true }));
    setVisitDetailErrors((current) => {
      const next = { ...current };
      delete next[encounterId];
      return next;
    });
    try {
      const detail = await api.fetchVisitDetail(patient.id, encounterId);
      setVisitDetails((current) => ({ ...current, [encounterId]: detail }));
    } catch (reason) {
      setVisitDetailErrors((current) => ({ ...current, [encounterId]: messageOf(reason) }));
    } finally {
      setVisitDetailLoading((current) => ({ ...current, [encounterId]: false }));
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
        <header className="odos-overview-band">
          <div className="odos-overview-band-row is-identity">
            <div className="odos-overview-identity">
              <h1>{name}</h1>
              <span>DOB <b>{patient.birthDate ? localDate(patient.birthDate) : "not recorded"}</b></span>
              <span>Age <b>{age ?? "not recorded"}</b></span>
            </div>
            {isVisible("billing-weather") && <BillingWeatherReport weather={overview?.billingWeather} />}
          </div>
          <div className="odos-overview-band-row is-visit">
            <PinnedOfficeNote patientId={patient.id} band />
            <StartExam patient={patient} />
          </div>
        </header>
        <nav className="odos-patient-tabs" role="tablist" aria-label="Patient chart views">
          <button
            type="button"
            role="tab"
            aria-selected={activePatientTab === "overview"}
            onClick={() => setActivePatientTab("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            role="tab"
            aria-label="Chart History"
            aria-selected={activePatientTab === "history"}
            onClick={() => setActivePatientTab("history")}
          >
            <span>History</span>
          </button>
        </nav>
        {activePatientTab === "history" && patient.id && (
          <PatientHistoryTimeline
            patientId={patient.id}
            loadHistory={api.fetchAuditHistory ?? fetchPatientHistory}
          />
        )}
        <div hidden={activePatientTab !== "overview"}>
        <div className="odos-overview-context">
          {isVisible("demographic-detail") && density("demographic-detail") === "compact" ? (
            <details className="odos-overview-demographics">
              <summary>Demographic detail</summary>
              <DemographicDetail demographics={demographics} patient={patient} chartNumber={chartNumber} overview={overview} />
            </details>
          ) : isVisible("demographic-detail") ? (
            <DemographicDetail demographics={demographics} patient={patient} chartNumber={chartNumber} overview={overview} />
          ) : null}
          <div className="odos-overview-actions">
            {isVisible("consult-drafts") && <button
              type="button"
              className="odos-overview-button"
              disabled={!patient.id}
              aria-expanded={correspondenceOpen}
              aria-controls="patient-consult-report"
              onClick={() => setCorrespondenceOpen(true)}
            >
              Start correspondence
            </button>}
            {isVisible("credit-bank-deposit-sheet") && <button type="button" className="odos-overview-button" onClick={() => setDepositingCreditBank(true)}>Deposit Credit Bank</button>}
            {isVisible("sale-sheet") && <button type="button" className="odos-overview-button" onClick={() => setSellingPackage(true)}>Sell package</button>}
          </div>
        </div>
        {isVisible("consult-drafts") && correspondenceOpen && patient.id && (
          <ConsultReportDraftPanel
            patientId={patient.id}
            onClose={() => setCorrespondenceOpen(false)}
            api={api.correspondence ?? referralApi}
          />
        )}

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
              {isVisible("document-history") && <button type="button" aria-expanded={historyOpen} aria-controls="patient-sticky-history" onClick={showHistory}>History</button>}
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

        {patient.id && (
          <section className="odos-sticky-note" aria-label="Patient SMS preferences">
            <SmsOptOutControl patientReference={`Patient/${patient.id}`} />
          </section>
        )}

        {error && <p className="odos-overview-error" role="alert">{error}</p>}
        {!overview && !error && <p className="odos-overview-loading">Loading patient overview…</p>}
        {overview && (
          <div className="odos-overview-grid">
            <div className="odos-overview-stack">
              {isVisible("patient-snapshot") && <PatientSnapshot snapshot={overview.snapshot} />}
              {isVisible("problem-list") && <ProblemListPanel rows={overview.snapshot.medicalConditions} />}
              {isVisible("active-programs") && patient.id && (
                <section className="odos-overview-card odos-programs-card" data-testid="overview-active-programs">
                  <span className="odos-overview-edge" />
                  <div className="odos-overview-kicker">Active programs</div>
                  <PatientProgramPanels
                    compact
                    programEnrollment={overview.programs?.length ? (
                      <div aria-label="Program enrollment" className="grid gap-2">
                        {overview.programs.map((program) => (
                          <div key={program.episodeOfCareReference} className="odos-program-enrollment-row">
                            {program.title} · {program.status}
                          </div>
                        ))}
                      </div>
                    ) : undefined}
                    packageStatus={isVisible("balance-chips") ? <BalanceChips patientReference={`Patient/${patient.id}`} revision={packageRevision} /> : undefined}
                    seriesStatus={<SeriesTrackerPanel patientReference={`Patient/${patient.id}`} api={api.seriesTracker} compact emptyMessage={isVisible("balance-chips") || overview.programs?.length ? "No active treatment series" : "No active programs"} />}
                  />
                </section>
              )}
              {isVisible("medications") && hasMedications && (
                <MedicationPanel snapshot={overview.snapshot} />
              )}
              {isVisible("medications") && overview.unavailable?.medicationOrders && (
                <p className="odos-overview-error" role="alert">{overview.unavailable.medicationOrders}</p>
              )}
              {isVisible("longitudinal-imaging") && patient.id && (
                <LongitudinalImagingCard patientReference={`Patient/${patient.id}`} hideWhenEmpty />
              )}
              {isVisible("optical-order") && patient.id && activeRxId && (
                <a className="odos-overview-tier-link" href={opticalOrderPath(patient.id, activeRxId)} title={rxError} onClick={navigateWithinApp}>Start optical order</a>
              )}
            </div>
            <div className="odos-overview-right">
              <section className="odos-overview-card odos-ledger-card" data-testid="overview-visit-ledger">
              <span className="odos-overview-edge" />
              <div className="odos-overview-kicker">Visit ledger <span>every visit · its diagnoses · at a glance</span></div>
              <div className="odos-ledger-filters">
                <FilterButton active={filter === "all"} onClick={() => applyFilter("all")}>All visits</FilterButton>
                <FilterButton active={filter === "eye-exams"} onClick={() => applyFilter("eye-exams")}>Eye exams</FilterButton>
                <FilterButton active={filter === "office-visits"} onClick={() => applyFilter("office-visits")}>Office visits</FilterButton>
                <label>By diagnosis
                  <OdosSelect
                    value={diagnosisFilter}
                    options={[
                      { value: "", label: "All diagnoses" },
                      ...overview.diagnosisChoices.map((choice) => ({
                        value: `${choice.system}|${choice.code}`,
                        label: choice.name,
                      })),
                    ]}
                    onChange={(value) => {
                      setDiagnosisFilter(value);
                      const diagnosis = overview.diagnosisChoices.find((choice) => `${choice.system}|${choice.code}` === value);
                      void applyFilter(filter, diagnosis ?? null);
                    }}
                    ariaLabel="By diagnosis"
                  />
                </label>
                <span className="odos-ledger-query-note">Live FHIR query</span>
              </div>
              {loadingLedger && <p className="odos-overview-loading">Refreshing visit ledger…</p>}
              {!loadingLedger && overview.visits.length === 0 && (
                <p className="odos-overview-none">{filter === "all" && !diagnosisFilter ? "No visits yet" : "No matching visits recorded"}</p>
              )}
              {!loadingLedger && overview.visits.map((visit) => {
                const metadata = visitMetadata(visit);
                return <article
                  className={[
                    "odos-visit-row",
                    openVisitId === visit.encounterId ? "is-open" : "",
                    openVisitId && openVisitId !== visit.encounterId ? "is-quiet" : "",
                  ].filter(Boolean).join(" ")}
                  key={visit.encounterId}
                  onClick={() => void toggleVisitDetail(visit.encounterId)}
                >
                  <button
                    type="button"
                    className="odos-visit-expand-sr"
                    aria-expanded={openVisitId === visit.encounterId}
                    aria-controls={`visit-explode-${visit.encounterId}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleVisitDetail(visit.encounterId);
                    }}
                  >
                    Expand visit details for {metadata.visitType ?? "visit"} on {visit.date ? shortDate(visit.date) : "date not recorded"}
                  </button>
                  <time>{visit.date ? monthDay(visit.date) : "Date not recorded"}<small>{visit.date ? yearOf(visit.date) : ""}</small></time>
                  <div className="odos-visit-head">
                    {metadata.visitType && <span className="odos-visit-type">{metadata.visitType}</span>}
                    {metadata.context && <span>{metadata.context}</span>}
                    {!metadata.visitType && !metadata.context && <span>—</span>}
                    <span data-testid={`visit-status-${visit.encounterId}`} className={
                      visit.status === "Final"
                        ? "is-final"
                        : visit.status === "Migrated" ? "is-migrated" : "is-preliminary"
                    }>
                      {visit.status}{visit.status === "Final" ? " ✓" : ""}
                    </span>
                    <button
                      type="button"
                      className="odos-visit-open"
                      aria-label={`Open ${metadata.visitType ?? "visit"} from ${visit.date ? shortDate(visit.date) : "date not recorded"}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setView({ kind: "encounter", patientId: patient.id ?? "", encounterId: visit.encounterId });
                      }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setView({ kind: "encounter", patientId: patient.id ?? "", encounterId: visit.encounterId });
                        }
                      }}
                    >
                      Open visit
                    </button>
                  </div>
                  <div className="odos-dx-row">
                    {visit.diagnoses.length === 0 && <span className="odos-overview-none">No confirmed diagnoses recorded for this visit</span>}
                    {visit.diagnoses.map((diagnosis) => (
                      <button
                        type="button"
                        className="odos-dx-chip"
                        key={diagnosis.conditionId}
                        onClick={(event) => {
                          event.stopPropagation();
                          setView({ kind: "encounter", patientId: patient.id ?? "", encounterId: diagnosis.encounterId });
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        {diagnosis.name}{diagnosis.laterality && <small>{diagnosis.laterality}</small>}{diagnosis.code && <code>{diagnosis.code}</code>}
                      </button>
                    ))}
                  </div>
                  {openVisitId === visit.encounterId && (
                    <VisitExplode
                      id={`visit-explode-${visit.encounterId}`}
                      detail={visitDetails[visit.encounterId]}
                      loading={visitDetailLoading[visit.encounterId] === true}
                      error={visitDetailErrors[visit.encounterId]}
                    />
                  )}
                </article>;
              })}
              </section>
              {isVisible("product-timeline") && patient.id && overview.visits[0] && (
                <button type="button" className="odos-overview-tier-link" onClick={() => setView({ kind: "encounter", patientId: patient.id!, encounterId: overview.visits[0]!.encounterId })}>Product timeline</button>
              )}
            </div>
          </div>
        )}
        {isVisible("sale-sheet") && sellingPackage && patient.id && (
          <SaleSheet
            patientReference={`Patient/${patient.id}`}
            patientName={name}
            onClose={() => setSellingPackage(false)}
            onSold={() => setPackageRevision((current) => current + 1)}
          />
        )}
        {isVisible("credit-bank-deposit-sheet") && depositingCreditBank && patient.id && (
          <CreditBankDepositSheet
            patientReference={`Patient/${patient.id}`}
            patientName={name}
            onClose={() => setDepositingCreditBank(false)}
            onDeposited={() => setPackageRevision((current) => current + 1)}
          />
        )}
        </div>
      </section>
    </main>
  );
}

function VisitExplode({
  id,
  detail,
  loading,
  error,
}: {
  id: string;
  detail?: PatientOverviewVisitDetail;
  loading: boolean;
  error?: string;
}) {
  const [openGroup, setOpenGroup] = useState<string>();
  const [openCard, setOpenCard] = useState<string>();

  return (
    <div id={id} className="odos-visit-explode" onClick={(event) => event.stopPropagation()}>
      {loading && <p className="odos-overview-loading">Loading encounter details…</p>}
      {error && <p className="odos-overview-error" role="alert">{error}</p>}
      {detail && (
        <React.Fragment>
          <VisitSummaryLine label="Reason" value={detail.reason ?? "not recorded"} />
          <VisitSummaryLine
            label="IOP"
            value={groupSummary(detail.iop)}
            group={detail.iop}
            open={openGroup === "iop"}
            openCard={openCard}
            onToggle={() => {
              setOpenGroup((current) => current === "iop" ? undefined : "iop");
              setOpenCard(undefined);
            }}
            onToggleCard={setOpenCard}
          />
          <VisitSummaryLine
            label="Meds"
            value={groupSummary(detail.medications)}
            group={detail.medications}
            open={openGroup === "medications"}
            openCard={openCard}
            onToggle={() => {
              setOpenGroup((current) => current === "medications" ? undefined : "medications");
              setOpenCard(undefined);
            }}
            onToggleCard={setOpenCard}
          />
          <VisitSummaryLine
            label="Findings"
            value={groupSummary(detail.findings)}
            group={detail.findings}
            open={openGroup === "findings"}
            openCard={openCard}
            onToggle={() => {
              setOpenGroup((current) => current === "findings" ? undefined : "findings");
              setOpenCard(undefined);
            }}
            onToggleCard={setOpenCard}
          />
          <VisitSummaryLine
            label="Plan"
            value={groupSummary(detail.plan)}
            group={detail.plan}
            open={openGroup === "plan"}
            openCard={openCard}
            onToggle={() => {
              setOpenGroup((current) => current === "plan" ? undefined : "plan");
              setOpenCard(undefined);
            }}
            onToggleCard={setOpenCard}
          />
          <VisitSummaryLine
            label="Financial"
            value={groupSummary(detail.financial)}
            group={detail.financial}
            open={openGroup === "financial"}
            openCard={openCard}
            onToggle={() => {
              setOpenGroup((current) => current === "financial" ? undefined : "financial");
              setOpenCard(undefined);
            }}
            onToggleCard={setOpenCard}
          />
        </React.Fragment>
      )}
    </div>
  );
}

function VisitSummaryLine({
  label,
  value,
  group,
  open = false,
  openCard,
  onToggle,
  onToggleCard,
}: {
  label: string;
  value: string;
  group?: PatientOverviewVisitDetailGroup;
  open?: boolean;
  openCard?: string;
  onToggle?: () => void;
  onToggleCard?: (cardId: string | undefined) => void;
}) {
  const hasDepth = Boolean(group?.cards.length);
  const content = (
    <React.Fragment>
      <span className="odos-visit-summary-label">{label}</span>
      <span className="odos-visit-summary-value">{value}</span>
      {hasDepth && <span className="odos-visit-depth-count">{group!.cards.length}</span>}
    </React.Fragment>
  );

  return (
    <section className={`odos-visit-summary-line${open ? " is-active" : ""}`}>
      {hasDepth ? (
        <button type="button" className="odos-visit-summary-trigger" aria-expanded={open} onClick={onToggle}>
          {content}
        </button>
      ) : (
        <div className="odos-visit-summary-static">{content}</div>
      )}
      {open && group && (
        <div className="odos-visit-detail-strip">
          {group.cards.map((card) => {
            const hasLevelThree = Boolean(card.values?.length);
            const cardContent = (
              <React.Fragment>
                {hasLevelThree && <span className="odos-visit-card-chevron">›</span>}
                <span className="odos-visit-card-kicker">{card.kicker}</span>
                <strong>{card.title}</strong>
                {card.detail && <span className="odos-visit-card-detail">{card.detail}</span>}
                {openCard === card.id && card.values && (
                  <span className="odos-visit-card-values">
                    {card.values.map((row) => (
                      <span key={`${card.id}-${row.label}`}>
                        <small>{row.label}</small>{row.value}
                      </span>
                    ))}
                  </span>
                )}
              </React.Fragment>
            );
            return hasLevelThree ? (
              <button
                type="button"
                className={`odos-visit-detail-card${openCard === card.id ? " is-active" : ""}`}
                key={card.id}
                aria-expanded={openCard === card.id}
                onClick={() => onToggleCard?.(openCard === card.id ? undefined : card.id)}
              >
                {cardContent}
              </button>
            ) : (
              <article className="odos-visit-detail-card" key={card.id}>{cardContent}</article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function groupSummary(group: PatientOverviewVisitDetailGroup): string {
  return [group.summary, group.unavailable].filter(Boolean).join(" · ") || "not recorded";
}

export function ConsultReportDraftPanel({
  patientId,
  onClose,
  api = referralApi,
  hideWhenEmpty = false,
}: {
  patientId: string;
  onClose: () => void;
  api?: Pick<ReferralApi, "listInboundReferrals" | "previewConsultReport">;
  hideWhenEmpty?: boolean;
}) {
  const [referrals, setReferrals] = useState<ServiceRequest[]>();
  const [selectedId, setSelectedId] = useState("");
  const [artifact, setArtifact] = useState<ConsultReportArtifactResponse>();
  const [error, setError] = useState<string>();
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api.listInboundReferrals(patientId, controller.signal)
      .then((rows) => {
        setReferrals(rows);
        setSelectedId(rows[0]?.id ?? "");
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(messageOf(reason));
      });
    return () => controller.abort();
  }, [api, patientId]);

  async function createDraft() {
    if (!selectedId) return;
    setPreviewing(true);
    setError(undefined);
    try {
      setArtifact(await api.previewConsultReport(patientId, selectedId));
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setPreviewing(false);
    }
  }

  if (hideWhenEmpty && !error && (!referrals || referrals.length === 0)) return null;

  return (
    <section id="patient-consult-report" className="odos-sticky-history" aria-label="Start correspondence">
      <div>
        <h2>Consult report</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {!referrals && !error && <p>Loading inbound referrals…</p>}
      {referrals?.length === 0 && <p>No inbound referral is available for a consult report.</p>}
      {referrals && referrals.length > 0 && (
        <React.Fragment>
          <label>
            Inbound referral
            <select
              aria-label="Inbound referral"
              value={selectedId}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setArtifact(undefined);
              }}
            >
              {referrals.map((referral) => (
                <option key={referral.id} value={referral.id}>
                  {referral.requester?.display ?? "Referrer not named"} · {referral.reasonCode?.[0]?.text ?? "Reason not recorded"}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={previewing} onClick={() => void createDraft()}>
            {previewing ? "Creating draft…" : "Create consult-report draft"}
          </button>
        </React.Fragment>
      )}
      {artifact && (
        <React.Fragment>
          <p>{artifact.sourceEncounter.label}</p>
          <iframe
            title="Consult report preview"
            src={`data:application/pdf;base64,${artifact.pdfBase64}`}
          />
        </React.Fragment>
      )}
      {error && <p className="odos-overview-error" role="alert">{error}</p>}
    </section>
  );
}

function DemographicDetail({
  demographics,
  patient,
  chartNumber,
  overview,
}: {
  demographics: string;
  patient: Patient;
  chartNumber?: string;
  overview?: PatientOverviewPayload;
}) {
  return (
    <div className="odos-overview-meta">
      <span>{demographics || "Age/sex not recorded"}</span>
      <span>DOB <b>{patient.birthDate ? localDate(patient.birthDate) : "not recorded"}</b></span>
      <span>Chart <b>{chartNumber ? `#${chartNumber}` : "not recorded"}</b></span>
      <span>{overview?.insurance.length ? overview.insurance.join(" · ") : overview?.unavailable?.insurance ?? "Insurance not recorded"}</span>
    </div>
  );
}

export function BillingWeatherReport({ weather }: { weather?: PatientOverviewBillingWeather }) {
  const deductible = weather?.deductibleRemainingCents;
  const state = weather?.state === "covered" && deductible === 0
    ? "covered"
    : weather?.state === "high-deductible" && typeof deductible === "number" && Number.isFinite(deductible) && deductible > 0
      ? "high-deductible"
      : weather?.state === "self-pay" || weather?.state === "vip-cash"
        ? weather.state
        : "unknown";
  const presentation = {
    covered: { glyph: "●", label: "Covered" },
    "high-deductible": { glyph: "●", label: "High deductible" },
    "self-pay": { glyph: "●", label: "Self-pay" },
    "vip-cash": { glyph: "★", label: "VIP cash" },
    unknown: { glyph: "●", label: "Coverage unknown" },
  }[state];
  const detail = [
    weather?.planName,
    typeof deductible === "number" && Number.isFinite(deductible) && deductible >= 0
      ? `${money(deductible)} deductible remaining`
      : undefined,
  ].filter(Boolean).join(" · ") || "No current eligibility detail";
  return (
    <details className={`odos-billing-weather is-${state}`} data-testid="billing-weather">
      <summary aria-label={`Billing weather: ${presentation.label}`}>
        <span aria-hidden="true">{presentation.glyph}</span>{presentation.label}
      </summary>
      <div>{detail}</div>
    </details>
  );
}

function PatientSnapshot({ snapshot }: { snapshot: PatientOverviewPayload["snapshot"] }) {
  const hasHistory = Boolean(snapshot.ocularHistory.length || snapshot.ocularSurgicalHistory.length || snapshot.socialHistory.length);
  return (
    <section className="odos-overview-card odos-snapshot-card" data-testid="overview-patient-snapshot">
      <span className="odos-overview-edge" />
      <div className="odos-overview-kicker">Patient snapshot</div>
      {!hasHistory && <p className="odos-overview-none">No recorded history</p>}
      <SnapshotList title="Ocular history" rows={snapshot.ocularHistory.map((row) => ({ label: row.name, detail: row.laterality }))} hideWhenEmpty />
      <SnapshotList title="Ocular surgical history" rows={snapshot.ocularSurgicalHistory.map((row) => ({ label: row.name, detail: row.date ? shortDate(row.date) : undefined }))} hideWhenEmpty />
      <SnapshotList title="Social / smoking history" rows={snapshot.socialHistory.map((label) => ({ label }))} hideWhenEmpty />
    </section>
  );
}

function ProblemListPanel({ rows }: { rows: PatientOverviewPayload["snapshot"]["medicalConditions"] }) {
  return (
    <section className="odos-overview-card odos-snapshot-card" data-testid="overview-problem-list">
      <span className="odos-overview-edge" />
      <div className="odos-overview-kicker">Problem list / conditions</div>
      <SnapshotList title="Medical conditions" rows={rows.map((row) => ({ label: row.name }))} emptyMessage="No active problems" />
    </section>
  );
}

function MedicationPanel({ snapshot }: { snapshot: PatientOverviewPayload["snapshot"] }) {
  return (
    <section className="odos-overview-card odos-snapshot-card" data-testid="overview-medications">
      <span className="odos-overview-edge" />
      <div className="odos-overview-kicker">Medications</div>
      <MedicationList title="Ophthalmic medications" rows={snapshot.ophthalmicMedications} hideWhenEmpty />
      <MedicationList title="Systemic medications" rows={snapshot.systemicMedications} hideWhenEmpty />
    </section>
  );
}

function SnapshotList({
  title,
  rows,
  emptyMessage,
  hideWhenEmpty = false,
}: {
  title: string;
  rows: Array<{ label: string; detail?: string }>;
  emptyMessage?: string;
  hideWhenEmpty?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (hideWhenEmpty && rows.length === 0) return null;
  const visibleRows = expanded ? rows : rows.slice(0, OVERVIEW_LIST_LIMIT);
  return (
    <section>
      <h2>{title}</h2>
      {rows.length > 0
        ? <ul>{visibleRows.map((row, index) => <li key={`${row.label}-${index}`}>{row.label}{row.detail && <small>{row.detail}</small>}</li>)}</ul>
        : emptyMessage && <p className="odos-overview-none">{emptyMessage}</p>}
      {rows.length > OVERVIEW_LIST_LIMIT && (
        <button type="button" className="odos-overview-list-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          {expanded ? `Show first ${OVERVIEW_LIST_LIMIT}` : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}

function MedicationList({
  title,
  rows,
  unavailable,
  hideWhenEmpty = false,
}: {
  title: string;
  rows: PatientOverviewMedication[];
  unavailable?: string;
  hideWhenEmpty?: boolean;
}) {
  if (hideWhenEmpty && rows.length === 0 && !unavailable) return null;
  return <section><h2>{title}</h2>{rows.length > 0 && <ul>{rows.map((row, index) => <li key={row.id ?? `${row.name}-${index}`}>{row.name}{row.sig && <small>{row.sig}</small>}</li>)}</ul>}{unavailable && <p className="odos-overview-error" role="alert">{unavailable}</p>}</section>;
}

function visitMetadata(visit: PatientOverviewPayload["visits"][number]): { visitType?: string; context?: string } {
  const visitType = recordedMetadata(visit.visitType, "Visit type not recorded");
  const context = [
    recordedMetadata(visit.program, "Program not recorded"),
    recordedMetadata(visit.seriesDesignation, "Series not recorded"),
    recordedMetadata(visit.provider, "Provider not recorded"),
    recordedMetadata(visit.facility, "Facility not recorded"),
  ].filter((value): value is string => Boolean(value)).join(" · ");
  return { ...(visitType ? { visitType } : {}), ...(context ? { context } : {}) };
}

function recordedMetadata(value: string | undefined, absentLabel: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.toLocaleLowerCase() !== absentLabel.toLocaleLowerCase() ? normalized : undefined;
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

function money(cents: number): string {
  const fractionDigits = cents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(cents / 100);
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
