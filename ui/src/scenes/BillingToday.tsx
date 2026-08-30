import { useEffect, useState } from "react";
import {
  loadTodayWatchers,
  updateWatcherTask,
  watcherMoney,
  type WatcherAlert,
  type WatcherTaskAction,
  type WatcherTodayProjection,
} from "../lib/watchers";

export function BillingToday({
  initialProjection,
  date = new Date().toISOString().slice(0, 10),
  loadProjection = loadTodayWatchers,
  applyAction = updateWatcherTask,
}: {
  initialProjection?: WatcherTodayProjection;
  date?: string;
  loadProjection?: (date: string) => Promise<WatcherTodayProjection>;
  applyAction?: (taskId: string, action: WatcherTaskAction) => Promise<unknown>;
} = {}) {
  const [projection, setProjection] = useState<WatcherTodayProjection | undefined>(initialProjection);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (initialProjection) return;
    let active = true;
    loadProjection(date)
      .then((loaded) => {
        if (active) {
          setProjection(loaded);
          setError(undefined);
        }
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, [date, initialProjection, loadProjection]);

  async function act(taskId: string, action: WatcherTaskAction) {
    setError(undefined);
    try {
      await applyAction(taskId, action);
      setProjection(await loadProjection(date));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <main className="min-h-screen bg-[var(--odos-page-ground)] px-5 py-6 text-[var(--odos-text)]">
      <header className="mb-5">
        <div className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--odos-faint)]">Billing</div>
        <h1 className="mt-1 text-2xl font-semibold">Today</h1>
        <p className="mt-1 text-sm text-[var(--odos-muted)]">Only the financial work that needs a human now.</p>
      </header>

      {error && <div role="alert" className="mb-4 border border-red-400/40 bg-red-950/50 px-4 py-3 text-sm text-red-100">{error}</div>}
      {!projection && !error && <div className="text-sm text-[var(--odos-muted)]">Loading today’s watch…</div>}

      {projection?.status === "degraded" && (
        <section role="alert" className="border border-amber-300/40 bg-amber-950/40 p-5 text-amber-100">
          <h2 className="font-semibold">Watch degraded</h2>
          <p className="mt-1 text-sm">
            Existing alerts are hidden because the engine is {projection.reason}.
            {projection.lastSuccessfulAt
              ? <> It last succeeded at <time dateTime={projection.lastSuccessfulAt}>{projection.lastSuccessfulAt}</time>.</>
              : " It has not completed successfully yet."}
          </p>
        </section>
      )}

      {projection?.status === "healthy" && (
        <>
          <SinceYesterday projection={projection} />
          <section className="mt-6" aria-labelledby="needs-human-title">
            <h2 id="needs-human-title" className="text-lg font-semibold">Needs a human</h2>
            {projection.items.length === 0 ? (
              <div className="mt-3 border border-[var(--odos-line)] bg-[var(--odos-surface)] p-8 text-center">
                <p className="font-semibold text-[var(--odos-text)]">Nothing needs a human today.</p>
                <p className="mt-1 text-sm text-[var(--odos-muted)]">Watching since {projection.goLiveAt.slice(0, 10)}.</p>
              </div>
            ) : (
              <div className="mt-3 grid gap-3">
                {projection.items.map((item) => <WatcherCard key={item.taskId} item={item} onAction={act} />)}
              </div>
            )}
            {projection.overflow.total > 0 && (
              <div className="mt-3 border border-[var(--odos-line)] bg-[var(--odos-surface)] px-4 py-3 text-sm text-[var(--odos-muted)]">
                {projection.overflow.total} more, grouped by reason: {projection.overflow.groups.map((group) => `${group.watcherId} (${group.count})`).join(", ")}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function SinceYesterday({ projection }: { projection: Extract<WatcherTodayProjection, { status: "healthy" }> }) {
  const { today, yesterday, delta } = projection.sinceYesterday;
  return (
    <section className="grid gap-3 md:grid-cols-3" aria-label="Since yesterday">
      <Metric label="Today" value={`${today.patientCount} patients · ${watcherMoney(today.dollarsCents)}`} />
      <Metric label="Yesterday" value={`${yesterday.patientCount} patients · ${watcherMoney(yesterday.dollarsCents)}`} />
      <Metric label="Change" value={`${signed(delta.patientCount)} patients · ${signedMoney(delta.dollarsCents)}`} />
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[var(--odos-line)] bg-[var(--odos-surface)] p-4">
      <div className="text-xs font-bold uppercase text-[var(--odos-faint)]">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function WatcherCard({
  item,
  onAction,
}: {
  item: WatcherAlert;
  onAction: (taskId: string, action: WatcherTaskAction) => void | Promise<void>;
}) {
  const [practitioner, setPractitioner] = useState("");
  return (
    <article data-watcher-card={item.watcherId} className="border border-[var(--odos-line)] [background:var(--odos-card-gradient)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-amber-300">{item.severity}</div>
          <h3 className="mt-1 font-semibold">{item.message}</h3>
          <p className="mt-1 text-sm text-[var(--odos-muted)]">{item.consequence}</p>
        </div>
        <a className="scheduler-button" href={`/frontdesk?appointmentId=${encodeURIComponent(item.appointmentId)}`}>Act at appointment</a>
      </div>
      <details className="mt-3 border-t border-[var(--odos-line)] pt-3">
        <summary className="cursor-pointer text-sm font-semibold text-[var(--odos-muted)]">More actions</summary>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="scheduler-button" type="button" onClick={() => void onAction(item.taskId, { action: "snooze", until: new Date(Date.now() + 60 * 60_000).toISOString() })}>Snooze</button>
          {item.dismissalReasons.map((reason) => (
            <button key={reason.code} className="scheduler-button" type="button" onClick={() => void onAction(item.taskId, { action: "dismiss", reason: reason.code })}>{reason.display}</button>
          ))}
          <label className="flex items-center gap-2 text-xs text-[var(--odos-muted)]">
            Reassign
            <input className="scheduler-input" value={practitioner} placeholder="Practitioner/id" onChange={(event) => setPractitioner(event.target.value)} />
          </label>
          <button className="scheduler-button" type="button" disabled={!practitioner.trim()} onClick={() => void onAction(item.taskId, { action: "reassign", practitioner: practitioner.trim() })}>Reassign</button>
        </div>
      </details>
    </article>
  );
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function signedMoney(cents: number): string {
  if (cents > 0) return `+${watcherMoney(cents)}`;
  if (cents < 0) return `-${watcherMoney(Math.abs(cents))}`;
  return watcherMoney(0);
}
