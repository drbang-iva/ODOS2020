import { useMemo, useState } from "react";
import {
  buildFindingCommand, canMutateDiagnosisFinding, findingReadOnlyLabel, groupFindingRows, orderedFindingSearchRows,
  type DiagnosisFindingMutation, type DiagnosisFindingsPayload, type EncounterFindingRow, type FindingEye,
} from "../../lib/diagnosis-findings";
import type { DiagnosisCandidateFinding, DiagnosisCandidateSuggestion } from "../../lib/clinical-graph-client";

interface FindingsTableProps {
  payload: DiagnosisFindingsPayload; patientReference: string; conditionReference: string; disabled: boolean;
  onMutate: (mutation: DiagnosisFindingMutation) => void | Promise<void>;
}
export function DiagnosisFindingsTable({ payload, patientReference, conditionReference, disabled, onMutate }: FindingsTableProps) {
  const [query,setQuery] = useState("");
  const [error,setError] = useState<string>();
  const blocked = disabled || !canMutateDiagnosisFinding(payload);
  const searchRows = useMemo(() => groupFindingRows(orderedFindingSearchRows(payload.searchIndex,payload.diagnosis?.stableKey)
    .filter(row => `${row.display} ${row.sectionKey}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))).slice(0,12),[payload.searchIndex,payload.diagnosis?.stableKey,query]);
  function send(rows: EncounterFindingRow[], operation: DiagnosisFindingMutation["operation"], options: Parameters<typeof buildFindingCommand>[3] = {}) {
    if (blocked || rows.some(row => !row.editable)) return;
    try { setError(undefined); void onMutate(buildFindingCommand(rows,patientReference,operation,{selectedConditionReference:conditionReference,searchIndex:payload.searchIndex,liveConditionReferences:payload.visitDiagnoses.map(d => d.conditionReference),...options})); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Findings unavailable"); }
  }
  return <section className="odos-diagnosis-findings" aria-labelledby="diagnosis-findings-heading">
    <div className="odos-diagnosis-findings-heading"><div><div className="odos-diagnosis-eyebrow">Documentation</div><h3 id="diagnosis-findings-heading">Findings</h3></div></div>
    {!payload.encounterEditable && <p role="status">{findingReadOnlyLabel(payload.readOnlyReason)}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="odos-diagnosis-findings-table-wrap"><table className="odos-diagnosis-findings-table">
      <thead><tr><th>Finding</th><th>Exam section</th><th>Presence</th><th>Grade</th><th>Laterality</th><th>Finding actions</th></tr></thead>
      <tbody>{groupFindingRows(payload.findings).map(rows => <FindingRow key={rows.map(r => r.rowKey).join("|")} rows={rows} disabled={blocked} send={send} searchIndex={payload.searchIndex} />)}</tbody>
    </table></div>
    <div className="odos-diagnosis-finding-search"><label><span>Find another finding</span><input type="search" value={query} placeholder="Search findings" disabled={blocked} onChange={event => setQuery(event.target.value)} /></label>
      {query.trim() && <div className="odos-diagnosis-finding-search-results">{searchRows.map(rows => <button type="button" key={rows.map(r => r.rowKey).join("|")} disabled={blocked || rows.some(r => !r.editable || !r.key || !r.baseline)} onClick={() => send(rows,rows.every(r => r.carried && r.status === "live" && r.presence === "present") ? "reassert" : "assert",{presence:"present"})}><span>{rows[0].display}</span><small>{rows[0].sectionKey} · {rows.length === 2 ? "OU" : rows[0].eye}</small></button>)}</div>}
    </div>
  </section>;
}
function FindingRow({rows,disabled,send,searchIndex}:{rows:EncounterFindingRow[];disabled:boolean;send:(rows:EncounterFindingRow[],operation:DiagnosisFindingMutation["operation"],options?:Parameters<typeof buildFindingCommand>[3])=>void;searchIndex:EncounterFindingRow[]}) {
  const row = rows[0];
  const [eye,setEye] = useState<FindingEye | "OU" | "">("");
  const charted = row.kind === "fact" && row.status === "live";
  const readOnlyRow = rows.find(r => !r.editable);
  const blocked = disabled || !!readOnlyRow;
  const selectedRows = row.eye === "UNKNOWN" ? searchIndex.filter(r => r.atomicFindingId === row.atomicFindingId && (eye === "OU" || r.eye === eye)) : rows;
  const presenceBlocked = blocked || selectedRows.length === 0 || selectedRows.some(r => !r.key || !r.baseline || !r.editable);
  const laterality = rows.length === 2 ? "OU" : row.eye;
  return <tr className={charted ? "is-charted" : "is-offered"}>
    <td><strong>{row.display}</strong><small>{charted ? "Charted" : "Offered"}{row.carried && <span className="odos-finding-carried">carried</span>}</small>{readOnlyRow && <small>{findingReadOnlyLabel(readOnlyRow.readOnlyReason ?? (readOnlyRow.kind === "conflict" ? "conflict" : undefined))}</small>}{row.priorPresence === "absent" && <small>Prior: absent{row.priorGrade ? ` · Grade ${row.priorGrade}` : ""}{row.priorLaterality ? ` · ${row.priorLaterality}` : ""}</small>}</td>
    <td>{row.sectionKey}</td>
    <td><div className="odos-finding-presence" role="group" aria-label={`${row.display} presence`}>{(["present","absent"] as const).map(presence => <button key={presence} type="button" className={charted && row.presence === presence ? `is-selected is-${presence}` : ""} aria-label={charted && row.presence === presence ? `Clear ${presence} ${row.display}` : `Record ${row.display} ${presence}`} aria-pressed={charted && row.presence === presence} disabled={presenceBlocked} onClick={() => send(selectedRows,charted && row.presence === presence ? "clear" : "assert",{presence})}>{presence === "present" ? "Present" : "Absent"}</button>)}</div></td>
    <td>{row.gradeScale.length ? <select aria-label={`Grade ${row.display}`} value={row.grade ?? ""} disabled={blocked || !charted} onChange={event => send(rows,"grade",{grade:event.target.value || null})}><option value="">Not graded</option>{row.gradeScale.map(grade => <option key={grade} value={grade}>{grade}</option>)}</select> : <span>—</span>}</td>
    <td><span>{laterality}</span><select aria-label={`Laterality ${row.display}`} value={row.eye === "UNKNOWN" ? eye : laterality} disabled={blocked || (!charted && row.eye !== "UNKNOWN")} onChange={event => {const value=event.target.value as FindingEye | "OU";if (row.eye === "UNKNOWN") setEye(value); else if (value !== laterality) send(rows,"eye-change",{toEyes:value === "OU" ? ["OD","OS"] : [value]});}}>{row.eye === "UNKNOWN" && <option value="">Choose eye</option>}<option value="OD">OD</option><option value="OS">OS</option><option value="OU">OU</option></select></td>
    <td>{charted ? "Saved" : "Choose presence"}</td>
  </tr>;
}
interface UnassignedProps {
  rows: EncounterFindingRow[]; visitDiagnoses: DiagnosisFindingsPayload["visitDiagnoses"]; patientReference: string; disabled: boolean;
  canWriteDiagnosis?: boolean;
  suggestionsByFinding?: Readonly<Record<string, DiagnosisCandidateFinding>>;
  onSuggest?: (suggestion: DiagnosisCandidateSuggestion, findingInstanceId: string) => void;
  onMutate: (mutation: DiagnosisFindingMutation) => void | Promise<void>;
}
export function UnassignedFindingsTray({ rows,visitDiagnoses,patientReference,disabled,canWriteDiagnosis=true,suggestionsByFinding={},onSuggest,onMutate }: UnassignedProps) {
  if (!rows.length) return null;
  return <section className="odos-unassigned-findings" aria-labelledby="unassigned-findings-heading"><h2 id="unassigned-findings-heading" className="odos-diagnosis-rail-heading">Unassigned findings</h2>{groupFindingRows(rows).map(group => {
    const row=group[0], blocked=disabled || group.some(r => !r.editable || !r.key || !r.baseline);
    const suggestionFinding=Object.values(suggestionsByFinding).find(finding => finding.candidates.some(candidate => candidate.supportingFacts?.some(fact => group.some(r => r.rowKey === fact.rowKey))) || finding.contributors?.some(contributor => group.some(r => r.contributors.some(c => c.reference === contributor.reference))));
    return <div className="odos-unassigned-finding" key={group.map(r => r.rowKey).join("|")}><strong>{row.display}</strong><small>{row.presence === "absent" ? "Absent" : "Present"} · {group.length === 2 ? "OU" : row.eye}</small>{!row.editable && <small>{findingReadOnlyLabel(row.readOnlyReason)}</small>}
      {suggestionFinding && <div className="odos-unassigned-finding-suggestions"><small>suggests:</small>{suggestionFinding.candidates.map(suggestion => <button type="button" key={suggestion.diagnosisKey ?? suggestion.familyGroup} className="odos-unassigned-finding-suggestion" disabled={blocked || (!canWriteDiagnosis && !visitDiagnoses.some(diagnosis => diagnosis.diagnosisKey === suggestion.diagnosisKey)) || suggestion.linkable === false || suggestionFinding.linkable === false} aria-label={`Add suggested diagnosis ${suggestion.display}`} onClick={() => !blocked && onSuggest?.(suggestion,suggestionFinding.findingInstanceId)}>{suggestion.display}</button>)}</div>}
      <div className="odos-unassigned-finding-actions">{visitDiagnoses.map(diagnosis => <button type="button" key={diagnosis.conditionReference} disabled={blocked} aria-label={`Assign ${row.display} to ${diagnosis.display}`} onClick={() => !blocked && void onMutate(buildFindingCommand(group,patientReference,"move",{selectedConditionReference:diagnosis.conditionReference}))}>{`Assign to ${diagnosis.display}`}</button>)}<button type="button" disabled={blocked} aria-label={`Record ${row.display} standalone`} onClick={() => !blocked && void onMutate(buildFindingCommand(group,patientReference,"standalone"))}>Record standalone</button></div>
    </div>;
  })}</section>;
}
