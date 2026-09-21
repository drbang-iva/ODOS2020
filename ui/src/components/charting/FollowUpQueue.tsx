import { useEffect, useRef, useState } from "react";
import { loadFollowUpQueue, decideFollowUpTest, type FollowUpQueueRow, type FollowUpQueueResult } from "../../lib/follow-up-queue";

type LoadState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; value: FollowUpQueueResult };
const stateLabels = { "for-review": "For review", "already-ordered": "Already ordered", unavailable: "Unavailable", "not-today": "Not today" };

export function FollowUpQueue({ encounterId, active }: { encounterId: string; active: boolean }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [rowState, setRowState] = useState<Record<string, { saving: boolean; error?: string }>>({});
  const generation = useRef(0);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    generation.current++;
    pending.current.clear();
    setRowState({});
    if (!active) return;
    const controller = new AbortController();
    let current = true;
    setState({ kind: "loading" });
    void loadFollowUpQueue(encounterId, controller.signal).then(
      value => { if (current) setState({ kind: "ready", value }); },
      () => { if (current) setState({ kind: "error" }); },
    );
    return () => { current = false; generation.current++; controller.abort(); };
  }, [encounterId, active, retry]);
  async function decide(row: FollowUpQueueRow) {
    const key = `${row.orderable}|${row.focus ?? ""}`;
    if (pending.current.has(key)) return;
    pending.current.add(key);
    const currentGeneration = generation.current;
    setRowState(previous => ({ ...previous, [key]: { saving: true } }));
    try {
      const value = await decideFollowUpTest(encounterId, { orderable: row.orderable, ...(row.focus !== undefined ? { focus: row.focus } : {}), decision: row.state === "not-today" ? "put-back" : "not-today" });
      if (generation.current === currentGeneration) {
        setState({ kind: "ready", value });
        setRowState(previous => ({ ...previous, [key]: { saving: false } }));
      }
    } catch (error) {
      if (generation.current === currentGeneration) setRowState(previous => ({ ...previous, [key]: { saving: false, error: error instanceof Error ? error.message : "The decision could not be saved." } }));
    } finally {
      if (generation.current === currentGeneration) pending.current.delete(key);
    }
  }
  const canDecide = state.kind === "ready" && state.value.recorded && state.value.canDecide;
  if (!active) return null;
  return <section className="odos-follow-up-queue" aria-label="Tests for today">
    <h2>Tests for today</h2>
    {state.kind === "loading" ? <p role="status">Loading tests…</p> : state.kind === "error" ?
      <div role="status"><p>The tests for this visit could not be loaded.</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div> :
      !state.value.recorded ? <p>No tests were recorded when this visit opened.</p> :
      state.value.rows.length === 0 ? <p>No tests are proposed for this visit.</p> :
      <ul>{state.value.rows.map(row => <li key={`${row.orderable}|${row.focus ?? ""}`}>
        <div className="odos-follow-up-queue-heading"><h3>{row.label}</h3><span className="odos-follow-up-queue-state" data-state={row.state}>{stateLabels[row.state]}</span></div>
        {row.sources.map((source, sourceIndex) => <p className="odos-follow-up-queue-source" key={sourceIndex}>{source}</p>)}
        {row.state === "unavailable" && <p className="odos-follow-up-queue-reason">{row.reason}</p>}
        {row.state === "not-today" && <>
          <p className="odos-follow-up-queue-decision">{row.decidedBy} · <time dateTime={row.decidedAt}>{new Date(row.decidedAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></p>
          <p className="odos-follow-up-queue-reason">The shape will not put it back.</p>
        </>}
        {canDecide && (row.state === "for-review" || row.state === "not-today") &&
          <button type="button" disabled={rowState[`${row.orderable}|${row.focus ?? ""}`]?.saving ?? false} onClick={() => decide(row)}>{row.state === "not-today" ? "Put back" : "Not today"}</button>}
        {rowState[`${row.orderable}|${row.focus ?? ""}`]?.error && <p role="status" className="odos-follow-up-queue-error">{rowState[`${row.orderable}|${row.focus ?? ""}`].error}</p>}
      </li>)}</ul>}
  </section>;
}
