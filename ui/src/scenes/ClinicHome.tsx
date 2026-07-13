import { useEffect, useState, type MouseEvent } from "react";
import { fetchClinicSummary, type ClinicSummary } from "../lib/clinic-summary";
import { patientOverviewView, useViewState } from "../lib/view-state";
import { PinnedOfficeNote, ageLabel as officeAgeLabel, useClinicSummaryContext, useOfficeChannel } from "../components/OfficeChannel";

export const CLINIC_PATIENTS_PATH = "/clinic/patients";

export function ClinicHome({ initialSummary }: { initialSummary?: ClinicSummary } = {}) {
  const setView = useViewState((state) => state.setView);
  const shellState = useClinicSummaryContext();
  const [standaloneSummary, setStandaloneSummary] = useState(initialSummary);
  const [standaloneError, setStandaloneError] = useState<string>();

  useEffect(() => {
    if (initialSummary || shellState) return;
    let active = true;
    fetchClinicSummary()
      .then((value) => active && setStandaloneSummary(value))
      .catch((reason) => active && setStandaloneError(reason instanceof Error ? reason.message : "Clinic summary unavailable."));
    return () => { active = false; };
  }, [initialSummary, shellState]);

  const summary = initialSummary ?? shellState?.summary ?? standaloneSummary;
  const error = shellState?.error ?? standaloneError;

  const date = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  const openPatient = (patientId: string | undefined) => patientId && setView(patientOverviewView(patientId));

  return (
    <main className="odos-clinic-home">
      <div className="odos-ambient" aria-hidden="true" />
      <section className="odos-clinic-body">
        <div className="odos-clinic-greeting">
          <h1>Good day.</h1>
          <span>{date}</span>
          <span className="odos-mode">The Clinic</span>
        </div>
        <WaitingOnMe summary={summary} error={error} />

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
                <div key={row.appointmentId ?? `${row.time}-${row.patient}`} className="odos-clinic-flow-row">
                  <button type="button" className="odos-clinic-flow-open" disabled={!row.patientId} onClick={() => openPatient(row.patientId)}>
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
                  <PinnedOfficeNote patientId={row.patientId} compact />
                </div>
              ))}
            </div>
            <div className="odos-clinic-target">Row order: with-you → roomed → waiting → unsigned check-outs → upcoming.</div>
            <a className="odos-clinic-foot" href="/schedule/day" onClick={navigateWithinApp}>Open full schedule →</a>
          </section>

          <div className="odos-clinic-stack">
            <SignatureCard summary={summary} openPatient={openPatient} />
            <OrdersCard summary={summary} openPatient={openPatient} />
          </div>

          <div className="odos-clinic-lower-row">
            <WiringCard tone="emerald" title="E-Rx & refills" testId="clinic-erx-card" message={summary?.erx.message ?? "Checking E-Rx wiring…"} />
            <WiringCard tone="amber" title="To review" testId="clinic-review-card" message={summary?.review.message ?? "Checking results-review wiring…"} />
            <OfficeCard />
          </div>
        </div>
      </section>
    </main>
  );
}

function WaitingOnMe({ summary, error }: { summary?: ClinicSummary; error?: string }) {
  if (error) return <div className="odos-clinic-waitstrip"><span className="odos-clinic-wait-chip is-unwired"><strong>Unavailable</strong><small>Clinic summary</small></span></div>;
  return (
    <div className="odos-clinic-waitstrip" aria-label="Waiting on me">
      <a className={`odos-clinic-wait-chip${summary && summary.signatures.count > 0 ? " is-alert" : " is-ok"}`} data-testid="clinic-wait-unsigned" href="#clinic-signatures">
        <strong>{summary ? summary.signatures.count : "…"}</strong><small>Unsigned charts</small>
      </a>
      <button className="odos-clinic-wait-chip is-unwired" data-testid="clinic-wait-results" type="button" disabled><strong>Not wired</strong><small>Results to review</small></button>
      <button className="odos-clinic-wait-chip is-unwired" data-testid="clinic-wait-refills" type="button" disabled><strong>Not wired</strong><small>Refill requests</small></button>
      <a className={`odos-clinic-wait-chip${summary?.orders.agingCount ? " is-alert" : " is-ok"}`} data-testid="clinic-wait-orders" href="/dispensary/lab-orders" onClick={navigateWithinApp}>
        <strong>{summary ? summary.orders.count : "…"}</strong><small>Orders in flight</small>
      </a>
      <button className="odos-clinic-wait-chip is-unwired" data-testid="clinic-wait-erx" type="button" disabled><strong>E-Rx not wired</strong><small>Honest state</small></button>
    </div>
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
    <section id="clinic-signatures" className="odos-clinic-card odos-tone-amber" data-testid="clinic-signatures-card">
      <span className="odos-card-edge" />
      <div className="odos-clinic-card-head"><span>Awaiting your signature</span><span className={summary?.signatures.count ? "is-alert" : "is-ok"}>{summary ? `${summary.signatures.count} chart${summary.signatures.count === 1 ? "" : "s"}` : "loading"}</span></div>
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

function OrdersCard({ summary, openPatient }: { summary?: ClinicSummary; openPatient(patientId?: string): void }) {
  return (
    <section className="odos-clinic-card odos-tone-emerald" data-testid="clinic-orders-card">
      <span className="odos-card-edge" />
      <div className="odos-clinic-card-head">
        <span>Orders in flight</span>
        <span className={summary?.orders.agingCount ? "is-alert" : "is-ok"}>{summary ? `${summary.orders.count} active · ${summary.orders.agingCount} aging` : "loading"}</span>
      </div>
      <div className="odos-clinic-orders">
        {summary?.orders.rows.length === 0 && <div className="odos-clinic-all-clear">No active lab orders ✓</div>}
        {summary?.orders.rows.slice(0, 5).map((row) => (
          <button key={row.reference} type="button" className={row.stale ? "is-old" : ""} disabled={!row.patientId} onClick={() => openPatient(row.patientId)}>
            <span>{row.patient} <i className={row.state === "needs-attention" || row.state === "report-due" ? "is-alert" : ""}>{orderStateLabel(row.state)}</i></span>
            <span>{row.description}</span>
            <span>{row.ageMinutes === undefined ? "age unavailable" : compactAgeLabel(row.ageMinutes)}</span>
          </button>
        ))}
      </div>
      <div className="odos-clinic-target">Aging flag: older than {summary?.orders.agingThresholdDays ?? 5} days.</div>
      <a className="odos-clinic-foot" href="/dispensary/lab-orders" onClick={navigateWithinApp}>Open orders worklist →</a>
    </section>
  );
}

function WiringCard({ tone, title, testId, message }: { tone: "emerald" | "amber"; title: string; testId: string; message: string }) {
  return (
    <section className={`odos-clinic-card odos-tone-${tone}`} data-testid={testId}>
      <span className="odos-card-edge" />
      <div className="odos-clinic-card-head"><span>{title}</span><span className="odos-live-tone-off">wiring state</span></div>
      <div className="odos-wiring-panel">{message}</div>
    </section>
  );
}

function OfficeCard() {
  const office = useOfficeChannel();
  return (
    <section className="odos-clinic-card odos-tone-sapphire" data-testid="clinic-office-card">
      <span className="odos-card-edge" />
      <div className="odos-clinic-card-head"><span>Office</span><span className={office.unread.length ? "is-alert" : "is-ok"}>{office.unread.length} unread</span></div>
      <div className="odos-clinic-office-list">
        {office.unread.length === 0 && <div className="odos-clinic-all-clear">Office clear ✓</div>}
        {office.unread.slice(0, 2).map((message) => <div key={message.id}><span>{message.sender.display}</span><span>{message.text}</span><span>{officeAgeLabel(message.sentAt)}</span></div>)}
      </div>
      <button className="odos-clinic-foot" type="button" onClick={() => office.setOpen(true)}>Open Office →</button>
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

function compactAgeLabel(minutes: number): string {
  if (minutes < 24 * 60) return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

function orderStateLabel(state: "ordered" | "at-lab" | "report-due" | "needs-attention"): string {
  if (state === "at-lab") return "at lab";
  if (state === "report-due") return "report due";
  if (state === "needs-attention") return "needs attention";
  return "ordered";
}

function dateLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString() ? "today" : new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
}
