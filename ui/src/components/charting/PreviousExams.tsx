import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendPreviousExamsPage,
  formatDiagnosisHistoryDate,
  loadPreviousExamsPage,
  previousDiagnosisRowLabel,
  pullPreviousDiagnosis,
  type DiagnosisPullRequest,
  type DiagnosisPullResult,
  type PreviousExamDiagnosis,
  type PreviousExamGroup,
} from "../../lib/diagnosis-carry-forward";

interface Props {
  encounterReference: string;
  canWriteDiagnosis?: boolean;
  onSelectDiagnosis: (reference: string) => void;
  fetchImpl?: typeof fetch;
}

export function PreviousExams({
  encounterReference,
  canWriteDiagnosis = false,
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
  const [unscopedCount, setUnscopedCount] = useState(0);
  const [carries, setCarries] = useState<Record<string, { request: DiagnosisPullRequest; result: DiagnosisPullResult; complete: boolean }>>({});
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
      setUnscopedCount(current => Math.max(current, page.unscopedCount ?? 0));
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
    setCarries({});
    setUnscopedCount(0);
    void loadPage(undefined, requestGeneration);
    return () => {
      generation.current += 1;
      pendingPulls.current.clear();
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

  async function selectOrPull(encounter: PreviousExamGroup, diagnosis: PreviousExamDiagnosis, action?: "retry" | "replan") {
    const rowKey = `${encounter.encounterReference}|${diagnosis.conditionReference}`;
    const previous = carries[rowKey];
    if (!action && (!canWriteDiagnosis || previous?.complete) && diagnosis.checked && diagnosis.currentConditionReference) {
      onSelectDiagnosis(diagnosis.currentConditionReference);
      return;
    }
    if (!canWriteDiagnosis) return;
    if (pendingPulls.current.has(rowKey)) return;
    const requestGeneration = generation.current;
    const requestToken = Symbol(rowKey);
    pendingPulls.current.set(rowKey, { generation: requestGeneration, token: requestToken });
    setPendingRows((current) => [...current, rowKey]);
    setPullError(undefined);
    try {
      if (action === "replan") {
        const page = await loadPreviousExamsPage(encounterReference, undefined, fetchImpl);
        if (generation.current !== requestGeneration) return;
        setEncounters(current => [...page.encounters, ...current.filter(group => !page.encounters.some(fresh => fresh.encounterReference === group.encounterReference))]);
        setUnscopedCount(page.unscopedCount ?? 0);
      }
      const request: DiagnosisPullRequest = previous && !previous.complete && action !== "replan" ? previous.request : {
        commandId: crypto.randomUUID(),
        sourceEncounterReference: encounter.encounterReference,
        sourceConditionReference: diagnosis.conditionReference,
        ...(action === "replan" ? { replan: true } : {}),
      };
      const response = await pullPreviousDiagnosis(encounterReference, request, fetchImpl);
      if (generation.current !== requestGeneration) return;
      const result = response.body;
      const complete = response.status >= 200 && response.status < 300 && !!result.conditionReference &&
        typeof result.alreadyPresent === "boolean" &&
        [result.conditionStep, result.planStep, result.linkStep].every(step => step === undefined || step === "applied") &&
        (result.findings === undefined || result.findings.complete) &&
        (result.lineageStep === undefined || result.lineageStep === "applied" || result.lineageStep === "not-attempted" && result.findings === undefined);
      setCarries(current => ({ ...current, [rowKey]: { request, result, complete } }));
      const confirmed = complete || [result.conditionStep, result.planStep, result.linkStep].includes("applied") ||
        result.findings?.outcomes.some(outcome => outcome.clinicalWrite === "confirmed");
      if (confirmed && typeof window !== "undefined") {
        const event = new Event("odos:encounter-findings-changed");
        Object.defineProperty(event, "detail", { value: { encounterReference } });
        window.dispatchEvent(event);
      }
      if (!complete || !result.conditionReference) return;
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
      if (
        generation.current === requestGeneration &&
        owner?.generation === requestGeneration &&
        owner.token === requestToken
      ) {
        pendingPulls.current.delete(rowKey);
        setPendingRows((current) => current.filter((key) => key !== rowKey));
      }
    }
  }

  if (!loaded && encounters.length === 0) {
    return <p className="odos-diagnosis-muted" role="status">Loading previous exams…</p>;
  }

  if (loaded && encounters.length === 0 && !pageError) {
    return <><p className="odos-diagnosis-muted">No previous exams recorded.</p>{unscopedCount > 0 && <p>Some older records could not be placed on a visit</p>}</>;
  }

  return (
    <div className="odos-previous-exams" data-testid="previous-exams">
      {unscopedCount > 0 && <p>Some older records could not be placed on a visit</p>}
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
              const carry = carries[rowKey];
              return (
                <div key={diagnosis.conditionReference}>
                  <button
                    type="button"
                    key={diagnosis.conditionReference}
                    className="odos-previous-diagnosis-row"
                    aria-label={`${diagnosis.checked ? canWriteDiagnosis && !carry ? "Check carry and select" : "Select" : "Pull"} ${previousDiagnosisRowLabel(diagnosis)}`}
                    aria-pressed={diagnosis.checked}
                    aria-busy={pending}
                    disabled={pending || !!carry && !carry.complete || (!canWriteDiagnosis && !(diagnosis.checked && diagnosis.currentConditionReference))}
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
                  {carry && <div role="status">
                    {carry.result.conditionStep && <p>Diagnosis: {carry.result.conditionStep}</p>}
                    {carry.result.planStep && <p>Plan: {carry.result.planStep}</p>}
                    {carry.result.linkStep && <p>Visit link: {carry.result.linkStep}</p>}
                    {carry.result.findings && <p>Findings: {carry.result.findings.complete ? "complete" : "incomplete"}</p>}
                    {carry.result.lineageStep && <p>Lineage: {carry.result.lineageStep}</p>}
                    {!carry.complete && <>
                      <p>{carry.result.error ?? "Carrying is not complete."}</p>
                      {canWriteDiagnosis && <button type="button" disabled={pending} onClick={() => void selectOrPull(encounter, diagnosis, carry.result.reason === "carry-incomplete" ? "replan" : "retry")}>
                        {carry.result.reason === "carry-incomplete" ? "Reload and carry findings again" : "Finish carrying"}
                      </button>}
                    </>}
                  </div>}
                </div>
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
