import { useState } from "react";
import type { Condition, Encounter } from "@medplum/fhirtypes";
import type { AttachedProcedure } from "../../lib/clinical-graph-client";

export interface ReorderImpressionRow {
  conditionReference: string;
  diagnosisDisplay: string;
  provisional: boolean;
  procedureDisplays: string[];
}

export function ReorderImpressionsModal({
  rows: initialRows,
  busy,
  attachmentError,
  onCancel,
  onSave,
}: {
  rows: ReorderImpressionRow[];
  busy: boolean;
  attachmentError?: string;
  onCancel: () => void;
  onSave: (conditionReferences: string[]) => Promise<void>;
}) {
  const [rows, setRows] = useState(() => initialRows.map((row) => ({ ...row })));
  const [draggedReference, setDraggedReference] = useState<string>();

  function move(reference: string, targetIndex: number) {
    setRows((current) => moveImpression(current, reference, targetIndex));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--odos-chart-scrim)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reorder-impressions-title"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-surface)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[color:var(--odos-line-2)] bg-[color:var(--odos-accent-tint-hi)] px-5 py-4">
          <button type="button" disabled={busy} onClick={onCancel} className="text-sm font-semibold text-[color:var(--odos-text)] disabled:opacity-50">
            Cancel
          </button>
          <h2 id="reorder-impressions-title" className="text-lg font-semibold text-[color:var(--odos-text)]">
            Reorder Impressions
          </h2>
          <button
            type="button"
            disabled={busy || rows[0]?.provisional === true}
            onClick={() => onSave(rows.map((row) => row.conditionReference))}
            className="text-sm font-semibold text-[color:var(--odos-text)] disabled:opacity-50"
          >
            Save
          </button>
        </div>
        <p className="px-5 py-3 text-center text-sm text-[color:var(--odos-muted)]">
          Drag impression to desired position.
        </p>
        {attachmentError && (
          <p role="alert" className="mx-5 mb-3 rounded border border-[color:var(--odos-amber)] bg-[color:var(--odos-amber-wash)] px-3 py-2 text-sm text-[color:var(--odos-amber)]">
            {attachmentError}
          </p>
        )}
        <div className="divide-y divide-[color:var(--odos-line)] border-t border-[color:var(--odos-line)]">
          {rows.map((row, index) => (
            <div
              key={row.conditionReference}
              data-condition-reference={row.conditionReference}
              className="flex items-center gap-3 px-5 py-4"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedReference) move(draggedReference, index);
                setDraggedReference(undefined);
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-[color:var(--odos-text)]">
                  {row.diagnosisDisplay}
                  {row.provisional && (
                    <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-amber-200">
                      Provisional
                    </span>
                  )}
                </div>
                {row.procedureDisplays.length > 0 && (
                  <div className="mt-1 text-sm text-[color:var(--odos-muted)]">
                    {row.procedureDisplays.join(" · ")}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Move ${row.diagnosisDisplay} up`}
                  disabled={busy || index === 0 || row.provisional && index === 1}
                  onClick={() => move(row.conditionReference, index - 1)}
                  className="rounded px-2 py-1 text-sm text-[color:var(--odos-muted)] disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${row.diagnosisDisplay} down`}
                  disabled={busy || index === rows.length - 1}
                  onClick={() => move(row.conditionReference, index + 1)}
                  className="rounded px-2 py-1 text-sm text-[color:var(--odos-muted)] disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  draggable={!busy}
                  aria-label={`Drag ${row.diagnosisDisplay}`}
                  onDragStart={(event) => {
                    setDraggedReference(row.conditionReference);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  className="ml-1 cursor-grab rounded px-2 py-1 text-lg leading-none text-[color:var(--odos-muted)] active:cursor-grabbing"
                >
                  ≡
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function moveImpression(
  rows: readonly ReorderImpressionRow[],
  reference: string,
  targetIndex: number,
): ReorderImpressionRow[] {
  const sourceIndex = rows.findIndex((row) => row.conditionReference === reference);
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= rows.length || sourceIndex === targetIndex) {
    return [...rows];
  }
  const next = [...rows];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved!);
  return next[0]?.provisional ? [...rows] : next;
}

export function buildReorderImpressionRows(
  encounter: Encounter,
  conditions: readonly Condition[],
  attachedProcedures: readonly AttachedProcedure[],
): ReorderImpressionRow[] {
  const conditionsByReference = new Map<string, Condition>(conditions.flatMap((condition) =>
    condition.id ? [[`Condition/${condition.id}`, condition] as const] : []
  ));
  const proceduresByDiagnosis = new Map<string, string[]>();
  for (const procedure of attachedProcedures) {
    for (const reference of procedure.diagnosisReferences) {
      proceduresByDiagnosis.set(reference, [
        ...(proceduresByDiagnosis.get(reference) ?? []),
        procedure.display,
      ]);
    }
  }
  return [...(encounter.diagnosis ?? [])]
    .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER))
    .flatMap((entry) => {
      const reference = entry.condition.reference;
      if (!reference) return [];
      const condition = conditionsByReference.get(reference);
      return [{
        conditionReference: reference,
        diagnosisDisplay: conditionDisplay(condition, reference),
        provisional: condition?.verificationStatus?.coding?.some((coding) => coding.code === "provisional") === true,
        procedureDisplays: proceduresByDiagnosis.get(reference) ?? [],
      }];
    });
}

function conditionDisplay(condition: Condition | undefined, fallback: string): string {
  return condition?.code?.text ??
    condition?.code?.coding?.find((coding) => coding.display)?.display ??
    condition?.code?.coding?.find((coding) => coding.code)?.code ??
    fallback;
}
