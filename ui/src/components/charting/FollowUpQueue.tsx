import { useEffect, useRef, useState } from "react";
import { acceptFollowUpTest, loadFollowUpQueue, decideFollowUpTest, type FollowUpQueueRow, type FollowUpQueueResult } from "../../lib/follow-up-queue";
import { procedureChargeApi } from "../../lib/clinical-graph-client";

type LoadState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; value: FollowUpQueueResult };
const stateLabels = { "for-review": "For review", "already-ordered": "Already ordered", unavailable: "Unavailable", "not-today": "Not today" };
function selectedVisitDiagnosis(pointer: string | undefined, diagnoses: readonly { reference: string }[]): string | undefined {
  return pointer && diagnoses.some(diagnosis => diagnosis.reference === pointer) ? pointer : undefined;
}

export function FollowUpQueue({ encounterId, active }: { encounterId: string; active: boolean }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [rowState, setRowState] = useState<Record<string, { saving: boolean; error?: string }>>({});
  const [diagnosisOpen, setDiagnosisOpen] = useState<Record<string, boolean>>({});
  const generation = useRef(0);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    generation.current++;
    pending.current.clear();
    setRowState({});
    setDiagnosisOpen({});
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
  async function mutate(row: FollowUpQueueRow, operation: () => Promise<FollowUpQueueResult>) {
    const key = `${row.orderable}|${row.focus ?? ""}`;
    if (pending.current.has(key)) return;
    pending.current.add(key);
    const currentGeneration = generation.current;
    setRowState(previous => ({ ...previous, [key]: { saving: true } }));
    try {
      const value = await operation();
      if (generation.current === currentGeneration) {
        setState({ kind: "ready", value });
        setRowState(previous => ({ ...previous, [key]: { saving: false } }));
      }
    } catch (error) {
      if (generation.current === currentGeneration) setRowState(previous => ({ ...previous, [key]: { saving: false, error: error instanceof Error ? error.message : "The change could not be saved." } }));
    } finally {
      if (generation.current === currentGeneration) pending.current.delete(key);
    }
  }
  function decide(row: FollowUpQueueRow) {
    return mutate(row, () => decideFollowUpTest(encounterId, { orderable: row.orderable, ...(row.focus !== undefined ? { focus: row.focus } : {}), decision: row.state === "not-today" ? "put-back" : "not-today" }));
  }
  function accept(row: FollowUpQueueRow) {
    return mutate(row, () => acceptFollowUpTest(encounterId, { orderable: row.orderable, ...(row.focus !== undefined ? { focus: row.focus } : {}) }));
  }
  function changeCharge(row: FollowUpQueueRow, change: { state?: "removed" | "accepted"; dxPointer?: string }) {
    if (!row.charge || (row.charge.status !== "billed" && row.charge.status !== "removed")) return;
    const proposalId = row.charge.proposalId;
    return mutate(row, async () => {
      await procedureChargeApi().patch(encounterId, proposalId, change);
      return loadFollowUpQueue(encounterId);
    });
  }
  const canDecide = state.kind === "ready" && state.value.recorded && state.value.canDecide;
  const canAccept = state.kind === "ready" && state.value.recorded && state.value.canAccept;
  const diagnoses = state.kind === "ready" && state.value.recorded ? [...(state.value.diagnoses ?? [])]
    .sort((left, right) => Number(right.matches) - Number(left.matches) || (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)) : [];
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
        {row.state === "already-ordered" && row.charge && <p className="odos-follow-up-queue-charge">{
          row.charge.status === "billed" ? `Billed${row.charge.dxDisplay ? ` · ${row.charge.dxDisplay}` : ""}` :
          row.charge.status === "removed" ? `Charge removed by ${row.charge.removedBy}` :
          row.charge.status === "none" ? "No charge recorded" :
          row.charge.status === "uncoded" ? `No charge — ${row.label} has no billing code in the fee schedule` :
          row.charge.status === "protocol-pending" ? "Protocol charge not yet billed" :
          row.charge.status === "charged-elsewhere" ? "Charged on this visit" : "Billed"
        }</p>}
        {canDecide && (row.state === "for-review" || row.state === "not-today") &&
          <button type="button" disabled={rowState[`${row.orderable}|${row.focus ?? ""}`]?.saving ?? false} onClick={() => decide(row)}>{row.state === "not-today" ? "Put back" : "Not today"}</button>}
        {canAccept && row.state === "for-review" && <button type="button" disabled={rowState[`${row.orderable}|${row.focus ?? ""}`]?.saving ?? false} onClick={() => accept(row)}>Accept</button>}
        {canAccept && row.state === "already-ordered" && row.charge?.status === "none" && <button type="button" disabled={rowState[`${row.orderable}|${row.focus ?? ""}`]?.saving ?? false} onClick={() => accept(row)}>Add charge</button>}
        {canAccept && row.state === "already-ordered" && row.charge?.status === "billed" && <>
          <button type="button" disabled={rowState[`${row.orderable}|${row.focus ?? ""}`]?.saving ?? false} onClick={() => changeCharge(row, { state: "removed" })}>Remove charge</button>
          <button type="button" disabled={rowState[`${row.orderable}|${row.focus ?? ""}`]?.saving ?? false} onClick={() => setDiagnosisOpen(previous => ({ ...previous, [`${row.orderable}|${row.focus ?? ""}`]: !previous[`${row.orderable}|${row.focus ?? ""}`] }))}>Change diagnosis</button>
          {diagnosisOpen[`${row.orderable}|${row.focus ?? ""}`] && <select aria-label={`Diagnosis for ${row.label}`} value={selectedVisitDiagnosis(row.charge.dxPointer, diagnoses) ?? ""} disabled={rowState[`${row.orderable}|${row.focus ?? ""}`]?.saving ?? false} onChange={event => changeCharge(row, { dxPointer: event.target.value })}>
            {!selectedVisitDiagnosis(row.charge.dxPointer, diagnoses) && <option value="">Select diagnosis</option>}
            {diagnoses.map(diagnosis => <option key={diagnosis.reference} value={diagnosis.reference}>{diagnosis.display}</option>)}
          </select>}
        </>}
        {canAccept && row.state === "already-ordered" && row.charge?.status === "removed" && <button type="button" disabled={rowState[`${row.orderable}|${row.focus ?? ""}`]?.saving ?? false} onClick={() => changeCharge(row, { state: "accepted" })}>Restore charge</button>}
        {rowState[`${row.orderable}|${row.focus ?? ""}`]?.error && <p role="status" className="odos-follow-up-queue-error">{rowState[`${row.orderable}|${row.focus ?? ""}`].error}</p>}
      </li>)}</ul>}
  </section>;
}
