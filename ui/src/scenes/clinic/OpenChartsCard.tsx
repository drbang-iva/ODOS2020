import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchOpenCharts,
  isDoctorOpenCharts,
  OPEN_CHARTS_UNAVAILABLE,
  OpenChartsError,
  type Desk,
  type Doctor,
  type DoctorRow,
  type OpenChartsShape,
  type Owner,
  type Reason,
  type ReviewRow,
} from "../../lib/open-charts";
import type { PracticeRoleId } from "../../lib/practice-roles";

export const OPEN_CHARTS_REFRESH_MS = 60_000;

export type OpenChartsScope = "mine" | "all";
export type OpenChartsState = { data?: Doctor | Desk; error?: string };
export type OpenChartsView = OpenChartsState & { olderOpen: boolean; showOlder(): void; hideOlder(): void };

const REASON_PREFIX: Partial<Record<Reason["code"], string>> = {
  "needs-interpretation": "Needs interpretation",
  "unclassified-fee": "Fee not classified",
  "duplicate-fee": "Duplicate fee",
  "no-interpreted-result": "No interpreted result",
};

const REASON_TEXT: Partial<Record<Reason["code"], string>> = {
  "none-found": "No interpretation blockers found",
  "nothing-charted": "Nothing charted",
  "signature-missing": "Signature missing",
  "checks-unavailable": "Checks unavailable",
};

export function reasonChipText(reason: Reason): string {
  const prefix = REASON_PREFIX[reason.code];
  if (prefix) return reason.label ? `${prefix}: ${reason.label}` : prefix;
  return REASON_TEXT[reason.code] ?? "Checks unavailable";
}

/** Providers get the doctor card; every other role gets the desk summary line. */
export function openChartsShape(roles: readonly PracticeRoleId[]): OpenChartsShape {
  return roles.includes("provider") ? "doctor" : "desk";
}

/** "Mine" is the caller's charts plus every Unassigned chart. */
export function ownsChart(owner: Owner, practitioner: string | undefined): boolean {
  return "unassigned" in owner || owner.reference === practitioner;
}

export function visibleRows<T extends { owner: Owner }>(rows: readonly T[], practitioner: string | undefined, scope: OpenChartsScope): T[] {
  return scope === "all" || !practitioner ? [...rows] : rows.filter((row) => ownsChart(row.owner, practitioner));
}

export function olderSummary(older: Doctor["older"], practitioner: string | undefined, scope: OpenChartsScope): { count: number; oldestServiceDate?: string } {
  if (scope === "all" || !practitioner) return { count: older.count, ...(older.oldestServiceDate ? { oldestServiceDate: older.oldestServiceDate } : {}) };
  const mine = older.byOwner.filter((entry) => ownsChart(entry.owner, practitioner));
  const oldestServiceDate = mine.map((entry) => entry.oldestServiceDate).sort()[0];
  return { count: mine.reduce((total, entry) => total + entry.count, 0), ...(oldestServiceDate ? { oldestServiceDate } : {}) };
}

/** Waiting-strip numbers: behind = last clinic day + Older (mine for a doctor, every provider for the desk). */
export function openChartsChip(data: Doctor | Desk): { behind: number; today: number } {
  if (!isDoctorOpenCharts(data)) return { behind: (data.lastClinicDay?.count ?? 0) + data.older.count, today: data.today.count };
  const practitioner = data.caller.practitioner;
  return {
    behind: visibleRows(data.lastClinicDay?.rows ?? [], practitioner, "mine").length + olderSummary(data.older, practitioner, "mine").count,
    today: visibleRows(data.today.rows, practitioner, "mine").length,
  };
}

/** A practice calendar date (YYYY-MM-DD) as "Monday, Sep 21", or "Sep 21" when short. */
export function practiceDayLabel(date: string, style: "long" | "short" = "long"): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...(style === "long" ? { weekday: "long" as const } : {}), month: "short", day: "numeric" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

/** Service time in the practice's zone from the response, never the browser's. */
export function serviceTimeLabel(serviceStart: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
    .format(new Date(serviceStart))
    .replace(/[\u202f\u00a0]/g, " ");
}

const OLDER_AGE_BANDS: { label: string; minDays: number }[] = [
  { label: "Over 90 days", minDays: 91 },
  { label: "Over 60 days", minDays: 61 },
  { label: "Over 30 days", minDays: 31 },
  { label: "Over 1 week", minDays: 8 },
  { label: "Up to a week", minDays: 0 },
];

/** Calendar days between two practice dates (YYYY-MM-DD). */
function daysBetween(from: string, to: string): number {
  const utc = (date: string) => { const [year, month, day] = date.split("-").map(Number); return Date.UTC(year, month - 1, day); };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** Older rows grouped by age (youngest band first), keeping the server's order within each band; empty bands are omitted. */
export function olderAgeBands<T extends { serviceDate: string }>(rows: readonly T[], today: string): { label: string; rows: T[] }[] {
  const bands = [...OLDER_AGE_BANDS].reverse().map((band) => ({ label: band.label, rows: [] as T[] }));
  for (const row of rows) {
    const age = daysBetween(row.serviceDate, today);
    const label = OLDER_AGE_BANDS.find((band) => age >= band.minDays)!.label;
    bands.find((band) => band.label === label)!.rows.push(row);
  }
  return bands.filter((band) => band.rows.length > 0);
}

export function useOpenCharts(roles: readonly PracticeRoleId[], initialOpenCharts?: Doctor | Desk): OpenChartsView {
  const shape = openChartsShape(roles);
  const [state, setState] = useState<OpenChartsState>({});
  const [olderOpen, setOlderOpen] = useState(false);
  const olderOpenRef = useRef(false);
  const latestRequest = useRef(0);
  const mounted = useRef(false);

  // Only the newest request may settle the state, and a failure drops the old counts with it.
  // While Older is open every request carries expand=older, so its rows and the counts come from one response.
  const load = useCallback(() => {
    const request = ++latestRequest.current;
    return fetchOpenCharts(shape, { expandOlder: shape === "doctor" && olderOpenRef.current })
      .then((data) => { if (mounted.current && request === latestRequest.current) setState({ data }); })
      .catch((reason) => { if (mounted.current && request === latestRequest.current) setState({ error: reason instanceof OpenChartsError ? reason.message : OPEN_CHARTS_UNAVAILABLE }); });
  }, [shape]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (initialOpenCharts || typeof window === "undefined" || typeof window.setInterval !== "function") return;
    setState({});
    void load();
    const handle = window.setInterval(() => void load(), OPEN_CHARTS_REFRESH_MS);
    return () => {
      latestRequest.current += 1;
      window.clearInterval(handle);
    };
  }, [initialOpenCharts, load]);

  const showOlder = useCallback(() => {
    olderOpenRef.current = true;
    setOlderOpen(true);
    void load();
  }, [load]);
  // Hiding retires any in-flight expand request, so it can never settle the state (or blank the card on failure).
  const hideOlder = useCallback(() => {
    latestRequest.current += 1;
    olderOpenRef.current = false;
    setOlderOpen(false);
  }, []);

  return { data: state.data ?? (state.error ? undefined : initialOpenCharts), error: state.error, olderOpen, showOlder, hideOlder };
}

export function OpenChartsCard({ data, error, olderOpen, showOlder, hideOlder, openPatient }: OpenChartsView & { openPatient(patientId?: string): void }) {
  return (
    <section id="clinic-open-charts" className="odos-clinic-card odos-tone-amber odos-open-charts" data-testid="clinic-open-charts-card">
      <span className="odos-card-edge" />
      {error
        ? <><div className="odos-clinic-card-head"><span>Open charts</span></div><div className="odos-clinic-error">{error}</div></>
        : !data
          ? <><div className="odos-clinic-card-head"><span>Open charts</span></div><div className="odos-clinic-empty">Loading open charts…</div></>
          : isDoctorOpenCharts(data)
            ? <DoctorOpenCharts data={data} olderOpen={olderOpen} showOlder={showOlder} hideOlder={hideOlder} openPatient={openPatient} />
            : <DeskOpenCharts data={data} />}
    </section>
  );
}

function DeskOpenCharts({ data }: { data: Desk }) {
  const parts = [
    `${data.today.count} today`,
    ...(data.lastClinicDay ? [`${data.lastClinicDay.count} from ${practiceDayLabel(data.lastClinicDay.date)}`] : []),
    `${data.older.count} older`,
  ];
  return (
    <>
      <div className="odos-clinic-card-head"><span>Open charts</span></div>
      <p className="odos-open-charts-desk-line">{`Open charts: ${parts.join(" · ")}`}</p>
    </>
  );
}

function DoctorOpenCharts({ data, olderOpen, showOlder, hideOlder, openPatient }: Pick<OpenChartsView, "olderOpen" | "showOlder" | "hideOlder"> & { data: Doctor; openPatient(patientId?: string): void }) {
  const [chosenScope, setScope] = useState<OpenChartsScope>("mine");
  const practitioner = data.caller.practitioner;
  const scope: OpenChartsScope = practitioner ? chosenScope : "all";
  const today = visibleRows(data.today.rows, practitioner, scope);
  const last = data.lastClinicDay ? visibleRows(data.lastClinicDay.rows, practitioner, scope) : [];
  const older = olderSummary(data.older, practitioner, scope);
  const review = visibleRows(data.needsReview, practitioner, scope);
  const showOwner = scope === "all";
  const olderRows = olderOpen && data.older.rows ? visibleRows(data.older.rows, practitioner, scope) : undefined;

  return (
    <>
      <div className="odos-clinic-card-head">
        <span>Open charts</span>
        {practitioner && (
          <span className="odos-open-charts-scope" role="group" aria-label="Whose open charts">
            <button type="button" aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>My charts</button>
            <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>All providers</button>
          </span>
        )}
      </div>

      <div className="odos-open-charts-group is-today" data-group="today">
        <h3>Today</h3>
        {today.length === 0
          ? <div className="odos-open-charts-empty">No open charts today.</div>
          : today.map((row) => <OpenChartRow key={row.encounterId} row={row} timeZone={data.timeZone} live showOwner={showOwner} openPatient={openPatient} />)}
      </div>

      {data.lastClinicDay && (
        <div className="odos-open-charts-group is-alert" data-group="last-clinic-day">
          <h3>{practiceDayLabel(data.lastClinicDay.date)}</h3>
          {last.length === 0
            ? <div className="odos-open-charts-empty">{`${practiceDayLabel(data.lastClinicDay.date)} is clear ✓`}</div>
            : last.map((row) => <OpenChartRow key={row.encounterId} row={row} timeZone={data.timeZone} showOwner={showOwner} openPatient={openPatient} />)}
        </div>
      )}

      <div className="odos-open-charts-group is-warn" data-group="older">
        <div className="odos-open-charts-older">
          <span>{`${data.complete ? "" : "at least "}${older.count} older${older.oldestServiceDate ? ` · oldest ${practiceDayLabel(older.oldestServiceDate, "short")}` : ""}`}</span>
          {olderOpen
            ? <button type="button" onClick={hideOlder}>Hide</button>
            : older.count > 0 && <button type="button" onClick={showOlder}>Show older</button>}
        </div>
        {olderOpen && !olderRows && <div className="odos-open-charts-empty">Loading older charts…</div>}
        {olderRows && olderAgeBands(olderRows, data.today.date).map((band) => (
          <div key={band.label} className="odos-open-charts-band" data-band={band.label}>
            <h4>{band.label}</h4>
            {band.rows.map((row) => <OpenChartRow key={row.encounterId} row={row} timeZone={data.timeZone} withDate showOwner={showOwner} openPatient={openPatient} />)}
          </div>
        ))}
      </div>

      {review.length > 0 && (
        <div className="odos-open-charts-group is-review" data-group="needs-review">
          <h3>Needs review</h3>
          {review.map((row) => <ReviewChartRow key={row.encounterId} row={row} showOwner={showOwner} openPatient={openPatient} />)}
        </div>
      )}

      <div className="odos-clinic-target">Today's charts stay open until you sign them. The last clinic day should be clear.</div>
      {!data.complete && <div className="odos-open-charts-incomplete">Some counts may be incomplete.</div>}
    </>
  );
}

function patientIdOf(reference: string): string | undefined {
  return reference.match(/^Patient\/([^/]+)$/)?.[1];
}

function ownerLabel(owner: Owner): string {
  return "unassigned" in owner ? "Unassigned" : owner.name;
}

function OpenChartRow({ row, timeZone, live = false, withDate = false, showOwner, openPatient }: {
  row: DoctorRow;
  timeZone: string;
  live?: boolean;
  withDate?: boolean;
  showOwner: boolean;
  openPatient(patientId?: string): void;
}) {
  const patientId = patientIdOf(row.patient.reference);
  const when = `${withDate ? `${practiceDayLabel(row.serviceDate, "short")} · ` : ""}${serviceTimeLabel(row.serviceStart, timeZone)}`;
  const meta = [row.visitType, when, live ? row.liveState : undefined, showOwner ? ownerLabel(row.owner) : undefined].filter(Boolean).join(" · ");
  return (
    <button type="button" className="odos-open-charts-row" disabled={!patientId} onClick={() => openPatient(patientId)}>
      <span className="odos-open-charts-who">{row.patient.name}</span>
      <span className="odos-open-charts-meta">{meta}</span>
      <span className="odos-open-charts-reasons">
        {row.reasons.map((reason, index) => <span key={`${reason.code}-${index}`} className="odos-open-charts-chip" data-reason={reason.code}>{reasonChipText(reason)}</span>)}
      </span>
    </button>
  );
}

function ReviewChartRow({ row, showOwner, openPatient }: { row: ReviewRow; showOwner: boolean; openPatient(patientId?: string): void }) {
  const patientId = patientIdOf(row.patient.reference);
  return (
    <button type="button" className="odos-open-charts-row" disabled={!patientId} onClick={() => openPatient(patientId)}>
      <span className="odos-open-charts-who">{row.patient.name}</span>
      <span className="odos-open-charts-meta">{[row.reason, showOwner ? ownerLabel(row.owner) : undefined].filter(Boolean).join(" · ")}</span>
    </button>
  );
}
