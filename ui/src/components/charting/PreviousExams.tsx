import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendPreviousExamsPage,
  formatDiagnosisHistoryDate,
  loadPreviousExamsPage,
  previousDiagnosisRowLabel,
  pullPreviousDiagnosis,
  type PreviousExamDiagnosis,
  type PreviousExamGroup,
} from "../../lib/diagnosis-carry-forward";

interface Props {
  encounterReference: string;
  onSelectDiagnosis: (reference: string) => void;
  fetchImpl?: typeof fetch;
}

export function PreviousExams({
  encounterReference,
  onSelectDiagnosis,
  fetchImpl = fetch,
}: Props) {
  const [encounters, setEncounters] = useState<PreviousExamGroup[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState<string>();
  const [pullError, setPullError] = useState<string>();
  const [pendingRows, setPendingRows] = useState<string[]>([]);
  const generation = useRef(0);
  const nextCursorRef = useRef<string>();
  const consumedCursors = useRef(new Set<string>());
  const inFlightPage = useRef<{ key: string; token: symbol }>();
  const pendingPulls = useRef(new Map<string, { generation: number; token: symbol }>());
  const sentinel = useRef<HTMLButtonElement | null>(null);

  const loadPage = useCallback(async (cursor: string | undefined, requestGeneration: number) => {
    const key = cursor ?? "initial";
    if (generation.current !== requestGeneration) return;
    if (cursor && (nextCursorRef.current !== cursor || consumedCursors.current.has(cursor))) return;
    if (inFlightPage.current?.key === key) return;
    const token = Symbol(key);
    inFlightPage.current = { key, token };
    setPageBusy(true);
    setPageError(undefined);
    try {
      const page = await loadPreviousExamsPage(encounterReference, cursor, fetchImpl);
      if (
        generation.current !== requestGeneration ||
        inFlightPage.current?.token !== token ||
        (cursor !== undefined && nextCursorRef.current !== cursor)
      ) return;
      if (cursor) consumedCursors.current.add(cursor);
      nextCursorRef.current = page.nextCursor;
      setEncounters((current) => appendPreviousExamsPage(current, page));
      setNextCursor(page.nextCursor);
      setLoaded(true);
    } catch (caught) {
      if (generation.current !== requestGeneration) return;
      setPageError(caught instanceof Error ? caught.message : "Previous exams could not be loaded. Try again.");
      setLoaded(true);
    } finally {
      if (generation.current === requestGeneration && inFlightPage.current?.token === token) {
        inFlightPage.current = undefined;
        setPageBusy(false);
      }
    }
  }, [encounterReference, fetchImpl]);

  useEffect(() => {
    const requestGeneration = generation.current + 1;
    generation.current = requestGeneration;
    nextCursorRef.current = undefined;
    consumedCursors.current.clear();
    inFlightPage.current = undefined;
    pendingPulls.current.clear();
    setEncounters([]);
    setNextCursor(undefined);
    setLoaded(false);
    setPageError(undefined);
    setPullError(undefined);
    setPendingRows([]);
    void loadPage(undefined, requestGeneration);
    return () => {
      generation.current += 1;
    };
  }, [loadPage]);

  useEffect(() => {
    if (!nextCursor || !sentinel.current || typeof IntersectionObserver === "undefined") return;
    const requestGeneration = generation.current;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadPage(nextCursor, requestGeneration);
    });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [loadPage, nextCursor]);

  async function selectOrPull(encounter: PreviousExamGroup, diagnosis: PreviousExamDiagnosis) {
    if (diagnosis.checked && diagnosis.currentConditionReference) {
      onSelectDiagnosis(diagnosis.currentConditionReference);
      return;
    }
    const rowKey = `${encounter.encounterReference}|${diagnosis.conditionReference}`;
    if (pendingPulls.current.has(rowKey)) return;
    const requestGeneration = generation.current;
    const requestToken = Symbol(rowKey);
    pendingPulls.current.set(rowKey, { generation: requestGeneration, token: requestToken });
    setPendingRows((current) => [...current, rowKey]);
    setPullError(undefined);
    try {
      const result = await pullPreviousDiagnosis(
        encounterReference,
        encounter.encounterReference,
        diagnosis.conditionReference,
        fetchImpl,
      );
      if (generation.current !== requestGeneration) return;
      setEncounters((current) => current.map((group) => group.encounterReference !== encounter.encounterReference
        ? group
        : {
            ...group,
            diagnoses: group.diagnoses.map((row) => row.conditionReference !== diagnosis.conditionReference
              ? row
              : { ...row, checked: true, currentConditionReference: result.conditionReference }),
      }));
      onSelectDiagnosis(result.conditionReference);
    } catch (caught) {
      if (generation.current !== requestGeneration) return;
      setPullError(caught instanceof Error ? caught.message : "Diagnosis could not be pulled. Try again.");
    } finally {
      const owner = pendingPulls.current.get(rowKey);
      if (owner?.generation === requestGeneration && owner.token === requestToken) {
        pendingPulls.current.delete(rowKey);
        setPendingRows((current) => current.filter((key) => key !== rowKey));
      }
    }
  }

  if (!loaded && encounters.length === 0) {
    return <p className="odos-diagnosis-muted" role="status">Loading previous exams…</p>;
  }

  if (loaded && encounters.length === 0 && !pageError) {
    return <p className="odos-diagnosis-muted">No previous exams recorded.</p>;
  }

  return (
    <div className="odos-previous-exams" data-testid="previous-exams">
      {encounters.map((encounter) => (
        <section
          className="odos-previous-exam"
          data-encounter-reference={encounter.encounterReference}
          key={encounter.encounterReference}
        >
          <h3>{formatDiagnosisHistoryDate(encounter.date)} · {encounter.visitType}</h3>
          <div className="odos-previous-exam-diagnoses">
            {encounter.diagnoses.map((diagnosis) => {
              const rowKey = `${encounter.encounterReference}|${diagnosis.conditionReference}`;
              const pending = pendingRows.includes(rowKey);
              return (
                <button
                  type="button"
                  key={diagnosis.conditionReference}
                  className="odos-previous-diagnosis-row"
                  aria-label={`${diagnosis.checked ? "Select" : "Pull"} ${previousDiagnosisRowLabel(diagnosis)}`}
                  aria-pressed={diagnosis.checked}
                  aria-busy={pending}
                  disabled={pending}
                  data-source-condition-reference={diagnosis.conditionReference}
                  onClick={() => void selectOrPull(encounter, diagnosis)}
                >
                  <span className="odos-previous-diagnosis-check" aria-hidden="true">{diagnosis.checked ? "✓" : ""}</span>
                  <span>
                    <strong>{diagnosis.display}</strong>
                    <small>{diagnosis.identity.laterality}</small>
                    {diagnosis.findings.map((finding) => (
                      <small key={finding.observationReference}>
                        {finding.display}: {finding.presence}{finding.grade ? ` · Grade ${finding.grade}` : ""} · {finding.laterality}
                      </small>
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {pageError && <p className="odos-previous-exams-error" role="alert">{pageError}</p>}
      {pullError && <p className="odos-previous-exams-error" role="alert">{pullError}</p>}
      {nextCursor && (
        <button
          ref={sentinel}
          type="button"
          className="odos-previous-exams-more"
          aria-label="Load older encounters"
          aria-busy={pageBusy}
          disabled={pageBusy}
          onClick={() => void loadPage(nextCursor, generation.current)}
        >
          {pageBusy ? "Loading older encounters…" : pageError ? "Retry older encounters" : "Load older encounters"}
        </button>
      )}
    </div>
  );
}
