import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { fetchClinicSummary, type ClinicSummary } from "../lib/clinic-summary";
import { patientOverviewView, useViewState } from "../lib/view-state";
import { CLINIC_PATH } from "./DeskHome";

export const CLINIC_PATIENTS_PATH = "/clinic/patients";

export function ClinicHome({ initialSummary, switchPill }: { initialSummary?: ClinicSummary; switchPill?: ReactNode } = {}) {
  const setView = useViewState((state) => state.setView);
  const [summary, setSummary] = useState(initialSummary);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (initialSummary) return;
    let active = true;
    fetchClinicSummary()
      .then((value) => active && setSummary(value))
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : "Clinic summary unavailable."));
    return () => { active = false; };
  }, [initialSummary]);

  const date = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  const openPatient = (patientId: string | undefined) => patientId && setView(patientOverviewView(patientId));

  return (
    <main className="odos-clinic-home">
      <div className="odos-ambient" aria-hidden="true" />
      <header className="odos-desk-topbar">
        <a className="odos-mark" href={CLINIC_PATH} onClick={navigateWithinApp}>ODOS <b>20/20</b></a>
        <span className="odos-location">Clinic home</span>
        <span className="odos-topbar-spacer" />
        <a className="odos-pill" href={CLINIC_PATIENTS_PATH} onClick={navigateWithinApp}>Sections</a>
        {switchPill}
      </header>

      <section className="odos-clinic-body">
        <div className="odos-clinic-greeting">
          <h1>Good day.</h1>
          <span>{date}</span>
          <span className="odos-mode">The Clinic</span>
        </div>
        <ClinicPulse summary={summary} error={error} />

        <div className="odos-clinic-grid">
          <section className="odos-clinic-card odos-clinic-flow-card odos-tone-sapphire">
            <span className="odos-card-edge" />
            <div className="odos-clinic-card-head">
              <span>Today's flow</span>
              <FlowStatus summary={summary} />
            </div>
            <div className="odos-clinic-flow">
              {!summary && !error && <div className="odos-clinic-empty">Loading today's flow…</div>}
              {error && <div className="odos-clinic-error">{error}</div>}
              {summary?.flow.length === 0 && <div className="odos-clinic-empty">No active appointments today.</div>}
              {summary?.flow.map((row) => (
                <button key={row.appointmentId ?? `${row.time}-${row.patient}`} type="button" className="odos-clinic-flow-row" disabled={!row.patientId} onClick={() => openPatient(row.patientId)}>
                  <time>{row.time}</time>
                  <span className="odos-clinic-who">{row.patient} <small>{[row.age, row.sex].filter((value) => value !== undefined).join(" ")}</small></span>
                  <span className="odos-clinic-row-detail">
                    <span className="odos-clinic-visit-type">{row.visitType}</span>
                    <span className={`odos-clinic-state is-${row.state}`}>● {row.stateDetail}{row.room ? ` · ${row.room}` : ""}</span>
                    {row.arrivedLateMinutes !== undefined && row.arrivedLateMinutes > 0 && <span className="odos-clinic-late">arrived {row.arrivedLateMinutes}m late</span>}
                    {row.waitingMinutes !== undefined && <span className="odos-clinic-wait">waiting {row.waitingMinutes}m</span>}
                    {row.timeInOfficeMinutes !== undefined && <span className="odos-clinic-wait">in office {row.timeInOfficeMinutes}m</span>}
                  </span>
                  <span className="odos-clinic-glyphs">{row.flags.unsigned && <span title="Chart not signed">✎</span>}</span>
                </button>
              ))}
            </div>
            <div className="odos-clinic-target">Row order: with-you → roomed → waiting → unsigned check-outs → upcoming.</div>
            <a className="odos-clinic-foot" href="/schedule/day" onClick={navigateWithinApp}>Open full schedule →</a>
          </section>

          <div className="odos-clinic-stack">
            <SignatureCard summary={summary} openPatient={openPatient} />
            <WiringCard tone="emerald" title="E-Rx & refills" testId="clinic-erx-card" message={summary?.erx.message ?? "Checking E-Rx wiring…"} />
            <WiringCard tone="amethyst" title="To review" testId="clinic-review-card" message={summary?.review.message ?? "Checking results-review wiring…"} />
          </div>
        </div>
      </section>
    </main>
  );
}

function ClinicPulse({ summary, error }: { summary?: ClinicSummary; error?: string }) {
  if (error) return <p className="odos-clinic-pulse"><b className="is-alert">Clinic summary unavailable</b></p>;
  if (!summary) return <p className="odos-clinic-pulse">Clinic pulse: loading…</p>;
  const next = summary.flow.find((row) => row.state === "roomed")
    ?? summary.flow.find((row) => row.state === "waiting")
    ?? summary.flow.find((row) => row.state === "scheduled");
  return (
    <p className="odos-clinic-pulse">
      Clinic pulse:{" "}
      {summary.signatures.count > 0
        ? <><b className="is-alert">{summary.signatures.count} chart{summary.signatures.count === 1 ? "" : "s"} await your signature</b> · </>
        : <><b className="is-ok">signatures clear ✓</b> · </>}
      <span>E-Rx queue not wired</span>
      {next && <> · next patient <b className={next.state === "roomed" ? "is-ok" : "is-info"}>{next.state}{next.state === "roomed" ? " ✓" : ""}</b></>}
    </p>
  );
}

function FlowStatus({ summary }: { summary?: ClinicSummary }) {
  if (!summary) return <span>loading</span>;
  const inOffice = summary.flow.filter((row) => row.state === "with-you" || row.state === "roomed" || row.state === "waiting").length;
  const seen = summary.flow.filter((row) => row.state === "checked-out").length;
  return <span className="is-ok">{inOffice} in office · {seen} of {summary.flow.length} seen</span>;
}

function SignatureCard({ summary, openPatient }: { summary?: ClinicSummary; openPatient(patientId?: string): void }) {
  return (
    <section className="odos-clinic-card odos-tone-amber" data-testid="clinic-signatures-card">
      <span className="odos-card-edge" />
      <div className="odos-clinic-card-head"><span>Awaiting your signature</span><span className="is-alert">{summary ? `${summary.signatures.count} chart${summary.signatures.count === 1 ? "" : "s"}` : "loading"}</span></div>
      {summary && (
        <>
          <div className="odos-clinic-signature-stats"><strong className="is-alert">{summary.signatures.count}<small>unsigned</small></strong><strong>{summary.signatures.olderThan24Hours}<small>&gt; 24h</small></strong></div>
          <div className="odos-clinic-signatures">
            {summary.signatures.rows.length === 0 && <div className="odos-clinic-all-clear">All charts signed ✓</div>}
            {summary.signatures.rows.map((row) => (
              <button key={row.encounterId} type="button" className={row.olderThan24Hours ? "is-old" : ""} disabled={!row.patientId} onClick={() => openPatient(row.patientId)}>
                <span>{row.patient}</span><span>{row.visitType} · {dateLabel(row.checkoutAt)}</span><span>{ageLabel(row.ageMinutes)}</span>
              </button>
            ))}
          </div>
          <div className="odos-clinic-target">Target: zero by end of day — same-day signing is the discipline.</div>
        </>
      )}
    </section>
  );
}

function WiringCard({ tone, title, testId, message }: { tone: "emerald" | "amethyst"; title: string; testId: string; message: string }) {
  return (
    <section className={`odos-clinic-card odos-tone-${tone}`} data-testid={testId}>
      <span className="odos-card-edge" />
      <div className="odos-clinic-card-head"><span>{title}</span><span className="odos-live-tone-off">wiring state</span></div>
      <div className="odos-wiring-panel">{message}</div>
    </section>
  );
}

function navigateWithinApp(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.history.pushState({}, "", event.currentTarget.href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function ageLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  const days = Math.floor(minutes / (24 * 60));
  return `${days} day${days === 1 ? "" : "s"}`;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString() ? "today" : new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
}
