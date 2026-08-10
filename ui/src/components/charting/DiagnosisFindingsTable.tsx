import { useMemo, useState } from "react";
import {
  orderedFindingRows,
  orderedFindingSearchRows,
  type AtomicFindingCatalogRow,
  type DiagnosisFindingMutation,
  type DiagnosisFindingsPayload,
  type EncounterFindingRow,
} from "../../lib/diagnosis-findings";

interface FindingsTableProps {
  payload: DiagnosisFindingsPayload;
  patientReference: string;
  conditionReference: string;
  disabled: boolean;
  onMutate: (mutation: DiagnosisFindingMutation) => void | Promise<void>;
}

export function DiagnosisFindingsTable({
  payload,
  patientReference,
  conditionReference,
  disabled,
  onMutate,
}: FindingsTableProps) {
  const [query, setQuery] = useState("");
  const searchRows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return orderedFindingSearchRows(payload.catalog, payload.diagnosis?.stableKey)
      .filter((row) => !normalized || `${row.display} ${row.sectionKey}`.toLocaleLowerCase().includes(normalized))
      .slice(0, 12);
  }, [payload.catalog, payload.diagnosis?.stableKey, query]);

  return (
    <section className="odos-diagnosis-findings" aria-labelledby="diagnosis-findings-heading">
      <div className="odos-diagnosis-findings-heading">
        <div>
          <div className="odos-diagnosis-eyebrow">Documentation</div>
          <h3 id="diagnosis-findings-heading">Findings</h3>
        </div>
      </div>
      <div className="odos-diagnosis-findings-table-wrap">
        <table className="odos-diagnosis-findings-table">
          <thead>
            <tr>
              <th>Finding</th>
              <th>Exam section</th>
              <th>Presence</th>
              <th>Grade</th>
              <th>Laterality</th>
              <th>Finding actions</th>
            </tr>
          </thead>
          <tbody>
            {orderedFindingRows(payload.findings).map((row) => (
              <FindingRow
                key={`${row.atomicFindingId}:${row.laterality}`}
                row={row}
                patientReference={patientReference}
                conditionReference={conditionReference}
                disabled={disabled || !payload.canWrite}
                onMutate={onMutate}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="odos-diagnosis-finding-search">
        <label>
          <span>Find another finding</span>
          <input
            type="search"
            value={query}
            placeholder="Search findings"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {query.trim() && (
          <div className="odos-diagnosis-finding-search-results">
            {searchRows.map((row) => (
              <button
                type="button"
                key={row.atomicFindingId}
                disabled={disabled || !payload.canWrite}
                onClick={() => void onMutate(assertMutation(row, patientReference, conditionReference, "present"))}
              >
                <span>{row.display}</span>
                <small>{row.sectionKey}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function FindingRow({
  row,
  patientReference,
  conditionReference,
  disabled,
  onMutate,
}: {
  row: EncounterFindingRow;
  patientReference: string;
  conditionReference: string;
  disabled: boolean;
  onMutate: FindingsTableProps["onMutate"];
}) {
  const charted = Boolean(row.observationReference && row.presence);
  return (
    <tr className={charted ? "is-charted" : "is-offered"}>
      <td>
        <strong>{row.display}</strong>
        <small>{charted ? "Charted" : "Offered"}</small>
      </td>
      <td>{row.sectionKey}</td>
      <td>
        <div className="odos-finding-presence" role="group" aria-label={`${row.display} presence`}>
          <button
            type="button"
            className={row.presence === "present" ? "is-selected is-present" : ""}
            aria-label={row.presence === "present" ? `Clear present ${row.display}` : `Record ${row.display} present`}
            aria-pressed={row.presence === "present"}
            disabled={disabled}
            onClick={() => void onMutate(row.presence === "present" && row.observationReference
              ? clearMutation(row.observationReference, patientReference)
              : assertMutation(row, patientReference, conditionReference, "present"))}
          >Present</button>
          <button
            type="button"
            className={row.presence === "absent" ? "is-selected is-absent" : ""}
            aria-label={row.presence === "absent" ? `Clear absent ${row.display}` : `Record ${row.display} absent`}
            aria-pressed={row.presence === "absent"}
            disabled={disabled}
            onClick={() => void onMutate(row.presence === "absent" && row.observationReference
              ? clearMutation(row.observationReference, patientReference)
              : assertMutation(row, patientReference, conditionReference, "absent"))}
          >Absent</button>
        </div>
      </td>
      <td>
        {row.gradeScale.length ? (
          <select
            aria-label={`Grade ${row.display}`}
            value={row.grade ?? ""}
            disabled={disabled || !row.observationReference}
            onChange={(event) => row.observationReference && void onMutate({
              action: "grade",
              patientReference,
              observationReference: row.observationReference,
              grade: event.target.value || null,
            })}
          >
            <option value="">Not graded</option>
            {row.gradeScale.map((grade) => <option value={grade} key={grade}>{grade}</option>)}
          </select>
        ) : <span className="odos-diagnosis-muted">—</span>}
      </td>
      <td>
        <div className={`odos-finding-laterality is-${row.lateralitySource}`}>
          <span>{row.laterality}</span>
          <small>{row.lateralitySource === "inherited" ? "From diagnosis" : "Overridden"}</small>
          {row.observationReference && (
            <select
              aria-label={`Laterality ${row.display}`}
              value={row.lateralitySource === "explicit" ? row.laterality : ""}
              disabled={disabled}
              onChange={(event) => void onMutate({
                action: "laterality",
                patientReference,
                observationReference: row.observationReference!,
                laterality: event.target.value
                  ? event.target.value as "OD" | "OS" | "OU"
                  : null,
              })}
            >
              <option value="">Use diagnosis</option>
              <option value="OD">OD</option>
              <option value="OS">OS</option>
              <option value="OU">OU</option>
            </select>
          )}
        </div>
      </td>
      <td>
        {row.observationReference
          ? <span className="odos-diagnosis-muted">Saved</span>
          : <span className="odos-diagnosis-muted">Choose presence</span>}
      </td>
    </tr>
  );
}

interface UnassignedProps {
  rows: EncounterFindingRow[];
  visitDiagnoses: DiagnosisFindingsPayload["visitDiagnoses"];
  patientReference: string;
  disabled: boolean;
  onMutate: (mutation: DiagnosisFindingMutation) => void | Promise<void>;
}

export function UnassignedFindingsTray({
  rows,
  visitDiagnoses,
  patientReference,
  disabled,
  onMutate,
}: UnassignedProps) {
  if (rows.length === 0) return null;
  return (
    <section className="odos-unassigned-findings" aria-labelledby="unassigned-findings-heading">
      <h2 id="unassigned-findings-heading" className="odos-diagnosis-rail-heading">Unassigned findings</h2>
      {rows.map((row) => row.observationReference && (
        <div className="odos-unassigned-finding" key={`${row.observationReference}:${row.atomicFindingId}`}>
          <strong>{row.display}</strong>
          <small>{row.presence === "absent" ? "Absent" : "Present"} · {row.laterality}</small>
          <div className="odos-unassigned-finding-actions">
            {visitDiagnoses.map((diagnosis) => (
              <button
                type="button"
                key={diagnosis.conditionReference}
                disabled={disabled}
                aria-label={`Assign ${row.display} to ${diagnosis.display}`}
                onClick={() => void onMutate({
                  action: "assign",
                  patientReference,
                  observationReference: row.observationReference!,
                  conditionReference: diagnosis.conditionReference,
                })}
              >{`Assign to ${diagnosis.display}`}</button>
            ))}
            <button
              type="button"
              disabled={disabled}
              aria-label={`Record ${row.display} standalone`}
              onClick={() => void onMutate({
                action: "standalone",
                patientReference,
                observationReference: row.observationReference!,
              })}
            >Record standalone</button>
          </div>
        </div>
      ))}
    </section>
  );
}

function assertMutation(
  row: Pick<AtomicFindingCatalogRow, "atomicFindingId"> &
    Partial<Pick<EncounterFindingRow, "laterality" | "observationReference">>,
  patientReference: string,
  conditionReference: string,
  presence: "present" | "absent",
): DiagnosisFindingMutation {
  return {
    action: "assert",
    patientReference,
    conditionReference,
    atomicFindingId: row.atomicFindingId,
    presence,
    ...(row.observationReference && row.laterality && row.laterality !== "UNKNOWN"
      ? { laterality: row.laterality }
      : {}),
  };
}

function clearMutation(observationReference: string, patientReference: string): DiagnosisFindingMutation {
  return { action: "clear", patientReference, observationReference };
}
