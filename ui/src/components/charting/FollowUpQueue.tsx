import { useEffect, useState } from "react";
import { loadFollowUpQueue, type FollowUpQueueResult } from "../../lib/follow-up-queue";

type LoadState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; value: FollowUpQueueResult };
const stateLabels = { "for-review": "For review", "already-ordered": "Already ordered", unavailable: "Unavailable" };

export function FollowUpQueue({ encounterId, active }: { encounterId: string; active: boolean }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let current = true;
    setState({ kind: "loading" });
    void loadFollowUpQueue(encounterId, controller.signal).then(
      value => { if (current) setState({ kind: "ready", value }); },
      () => { if (current) setState({ kind: "error" }); },
    );
    return () => { current = false; controller.abort(); };
  }, [encounterId, active, retry]);
  if (!active) return null;
  return <section className="odos-follow-up-queue" aria-label="Tests for today">
    <h2>Tests for today</h2>
    {state.kind === "loading" ? <p role="status">Loading tests…</p> : state.kind === "error" ?
      <div role="status"><p>The tests for this visit could not be loaded.</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div> :
      !state.value.recorded ? <p>No tests were recorded when this visit opened.</p> :
      state.value.rows.length === 0 ? <p>No tests are proposed for this visit.</p> :
      <ul>{state.value.rows.map((row, index) => <li key={`${row.orderable}|${row.focus ?? ""}|${index}`}>
        <div className="odos-follow-up-queue-heading"><h3>{row.label}</h3><span className="odos-follow-up-queue-state" data-state={row.state}>{stateLabels[row.state]}</span></div>
        {row.sources.map((source, sourceIndex) => <p className="odos-follow-up-queue-source" key={sourceIndex}>{source}</p>)}
        {row.state === "unavailable" && <p className="odos-follow-up-queue-reason">{row.reason}</p>}
      </li>)}</ul>}
  </section>;
}
