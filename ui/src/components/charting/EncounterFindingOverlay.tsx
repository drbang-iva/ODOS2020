import { useEffect, useState } from "react";
import {
  loadDiagnosisFindings,
  type DiagnosisFindingsPayload,
  type EncounterFindingRow,
} from "../../lib/diagnosis-findings";

interface Props {
  encounterReference: string;
  sectionKey: string;
  loadPayload?: (encounterReference: string) => ReturnType<typeof loadDiagnosisFindings>;
  eventTarget?: EventTarget;
}

const defaultLoadPayload = (encounterReference: string) => loadDiagnosisFindings(encounterReference);

export function EncounterFindingOverlay({
  encounterReference,
  sectionKey,
  loadPayload = defaultLoadPayload,
  eventTarget = typeof window === "undefined" ? undefined : window,
}: Props) {
  const [unavailable, setUnavailable] = useState(false);
  const [rows, setRows] = useState<EncounterFindingRow[]>([]);

  useEffect(() => {
    let active = true;
    const load = () => loadPayload(encounterReference)
      .then((payload) => {
        if (!active) return;
        if ("result" in payload) { setUnavailable(true); setRows([]); return; }
        setUnavailable(false);
        setRows(findingRowsForSection(payload, sectionKey));
      })
      .catch((caught) => {
        if (!active) return;
        console.error("Encounter finding overlay unavailable.", caught);
        setRows([]);
        setUnavailable(true);
      });
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ encounterReference?: string }>).detail;
      if (detail?.encounterReference === encounterReference) void load();
    };
    void load();
    eventTarget?.addEventListener("odos:encounter-findings-changed", refresh);
    return () => {
      active = false;
      eventTarget?.removeEventListener("odos:encounter-findings-changed", refresh);
    };
  }, [encounterReference, eventTarget, loadPayload, sectionKey]);

  if (unavailable) return <div role="status">Findings unavailable</div>;
  if (rows.length === 0) return null;
  return (
    <section className="odos-encounter-finding-overlay" aria-labelledby="encounter-finding-overlay-heading">
      <div>
        <div className="odos-diagnosis-eyebrow">Shared encounter findings</div>
        <h2 id="encounter-finding-overlay-heading">Findings in this section</h2>
      </div>
      <ul>
        {rows.map((row) => (
          <li key={row.rowKey}>
            <div>
              <strong>{row.display}</strong>
              <span>{findingSummary(row)}</span>
            </div>
            <small>{row.kind === "conflict" ? "Conflicting records" : row.kind === "unresolved" ? "Unresolved finding" : "Shared finding"}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function findingRowsForSection(
  payload: Pick<DiagnosisFindingsPayload, "bySection">,
  sectionKey: string,
): EncounterFindingRow[] {
  return payload.bySection?.[sectionKey] ?? [];
}

function findingSummary(row: EncounterFindingRow): string {
  return [
    row.presence === "absent" ? "Absent" : row.presence === "present" ? "Present" : undefined,
    row.grade,
    row.laterality,
  ].filter(Boolean).join(" · ");
}
