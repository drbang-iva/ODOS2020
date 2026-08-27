import { useEffect, useMemo, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { OdosWheel } from "../inputs/OdosWheel";
import { OdosChips } from "../inputs/OdosChips";
import { OdosSelect } from "../inputs/OdosSelect";
import type {
  ClockHourExtentValue,
  CustomFindingDefinition,
  CustomFindingField,
  FindingDetails,
  FindingQualifierValue,
} from "./CustomFindingSection";
import { EyeCopyButton } from "./EyeCopyButton";
import {
  FindingWorksheetRow,
  PriorValue,
  findingChipLabel,
  isClockHourExtentValue,
  replaceSelectionGroup,
  type PriorFindingReadings,
} from "./FindingWorksheetControls";
import { formatStepValue } from "./power-options";
import { DiagnosisPicker } from "./DiagnosisPicker";
import type { SectionSaveStatus } from "./types";

export type Eye = "OD" | "OS";
type ExamState = "normal" | "abnormal" | "deferred";

export interface EyeCapture {
  state?: ExamState;
  selections: string[];
  grades?: Record<string, number | string>;
  findingDetails?: FindingDetails;
  other: string;
  normalTemplate?: string;
}

interface HistoryRow {
  observationReference?: string;
  recordedAt: string;
  eye?: Eye;
  state?: ExamState;
  values: Array<{ code: string; value: number | string | string[] }>;
  findingDetails?: FindingDetails;
  other?: string;
  normalTemplate?: string;
}

interface CurrentHistory {
  identity: string;
  rowsByStableKey: Record<string, HistoryRow[]>;
}

type PriorReadings = Record<Eye, PriorFindingReadings>;

interface Props {
  definitions: CustomFindingDefinition[];
  focusedStableKey?: string;
  patientReference: string;
  encounterReference: string;
  encounterRecordedAt?: string;
  onSaved(status: SectionSaveStatus, stableKeys: string[]): void;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

const EYES: Eye[] = ["OD", "OS"];
const ANTERIOR_PREFIX = "ocular-health:anterior:";
const POSTERIOR_PREFIX = "ocular-health:posterior:";
const DRY_EYE_ANTERIOR_STABLE_KEY = "dry-eye:conjunctival-staining";

export function OcularHealthSection({
  definitions,
  focusedStableKey,
  patientReference,
  encounterReference,
  encounterRecordedAt,
  onSaved,
  apiBase,
  fetchImpl = fetch,
}: Props) {
  const [captures, setCaptures] = useState<Record<string, Record<Eye, EyeCapture>>>(() => emptyCaptures(definitions));
  const [pristine, setPristine] = useState<Record<string, Record<Eye, EyeCapture>>>(() => emptyCaptures(definitions));
  const [currentHistory, setCurrentHistory] = useState<CurrentHistory | null>(null);
  const [priors, setPriors] = useState<Record<string, PriorReadings>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedDiagnosisObservations, setSavedDiagnosisObservations] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const definitionKey = useMemo(() => definitions.map((definition) => definition.stableKey).join("|"), [definitions]);
  const historyIdentity = `${patientReference}\u0000${encounterReference}\u0000${definitionKey}`;
  const groups = useMemo(() => segmentGroups(definitions), [definitions]);
  const runnerEnabled = groups.some((group) => group.label === "Anterior Segment") &&
    groups.some((group) => group.label === "Posterior Segment");
  const runnerDefinitions = groups.flatMap((group) => group.definitions);
  const [focusedStructureKey, setFocusedStructureKey] = useState<string | undefined>(focusedStableKey);
  const highlightedStructureKey = runnerDefinitions.some((definition) => definition.stableKey === focusedStructureKey)
    ? focusedStructureKey
    : runnerDefinitions[0]?.stableKey;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setCurrentHistory(null);
    setPriors({});
    setSavedDiagnosisObservations({});
    const base = apiBase ?? clinicalGraphApiBase();
    Promise.all(definitions.map(async (definition) => {
      const endpoint = `${base}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}/history`;
      const currentQuery = new URLSearchParams({ patient: patientReference, encounter: encounterReference });
      const currentResponse = await fetchImpl(`${endpoint}?${currentQuery}`, { headers: authHeaders(), signal: controller.signal });
      const currentBody = await currentResponse.json() as { rows?: HistoryRow[]; error?: string };
      if (!currentResponse.ok) throw new Error(currentBody.error ?? `${definition.display} history failed: ${currentResponse.status}`);
      const currentRows = currentBody.rows ?? [];
      return [
        definition.stableKey,
        currentRows,
        captureFromRows(definition, currentRows),
        diagnosisObservationReferences(definition, currentRows),
      ] as const;
    }))
      .then((rows) => {
        if (controller.signal.aborted) return;
        const hydrated = Object.fromEntries(rows.map(([stableKey, , capture]) => [stableKey, capture]));
        setCaptures(hydrated);
        setPristine(hydrated);
        setSavedDiagnosisObservations(Object.fromEntries(rows.map(([stableKey, , , references]) => [stableKey, references])));
        setCurrentHistory({
          identity: historyIdentity,
          rowsByStableKey: Object.fromEntries(rows.map(([stableKey, currentRows]) => [stableKey, currentRows])),
        });
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [historyIdentity, apiBase, fetchImpl]);

  useEffect(() => {
    const encounterTimestamp = encounterRecordedAt ? Date.parse(encounterRecordedAt) : Number.NaN;
    if (currentHistory?.identity !== historyIdentity || !Number.isFinite(encounterTimestamp)) {
      setPriors({});
      return;
    }
    const controller = new AbortController();
    const base = apiBase ?? clinicalGraphApiBase();
    Promise.all(definitions.map(async (definition) => {
      try {
        const endpoint = `${base}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}/history`;
        const patientQuery = new URLSearchParams({ patient: patientReference });
        const response = await fetchImpl(`${endpoint}?${patientQuery}`, { headers: authHeaders(), signal: controller.signal });
        const body = await response.json() as { rows?: HistoryRow[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `${definition.display} prior history failed: ${response.status}`);
        if (body.rows !== undefined && !Array.isArray(body.rows)) throw new Error(`${definition.display} prior history was malformed.`);
        const priorRows = rowsBeforeEncounter(
          excludeCurrentEncounterRows(body.rows ?? [], currentHistory.rowsByStableKey[definition.stableKey] ?? []),
          encounterRecordedAt,
        );
        return [definition.stableKey, priorReadingsFromRows(definition, priorRows)] as const;
      } catch (caught) {
        if ((caught as Error).name === "AbortError") throw caught;
        return [definition.stableKey, emptyPriorReadings()] as const;
      }
    }))
      .then((rows) => {
        if (!controller.signal.aborted) setPriors(Object.fromEntries(rows));
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setPriors({});
      });
    return () => controller.abort();
  }, [historyIdentity, currentHistory, encounterRecordedAt, apiBase, fetchImpl]);

  useEffect(() => {
    if (runnerEnabled) {
      if (focusedStableKey) setFocusedStructureKey(focusedStableKey);
      return;
    }
    if (!focusedStableKey) return;
    scrollToStructure(focusedStableKey);
  }, [focusedStableKey, runnerEnabled]);

  useEffect(() => {
    if (!runnerEnabled || !focusedStructureKey) return;
    scrollToStructure(focusedStructureKey);
  }, [focusedStructureKey, runnerEnabled]);

  function focusStructure(stableKey: string) {
    if (stableKey === focusedStructureKey) {
      scrollToStructure(stableKey);
      return;
    }
    setFocusedStructureKey(stableKey);
  }

  function updateEye(stableKey: string, eye: Eye, update: (capture: EyeCapture) => EyeCapture) {
    setCaptures((current) => ({
      ...current,
      [stableKey]: {
        ...current[stableKey],
        [eye]: update(current[stableKey]?.[eye] ?? emptyEye()),
      },
    }));
  }

  function setExamState(definition: CustomFindingDefinition, eye: Eye, state: ExamState) {
    const current = captures[definition.stableKey]?.[eye] ?? emptyEye();
    if (current.state === "abnormal" && state !== "abnormal") {
      const described = describedFindingNames(abnormalField(definition), current);
      if (described.length > 0 && !confirmDestroy(described, "Changing the exam state")) return;
    }
    updateEye(definition.stableKey, eye, (current) => ({
      ...current,
      state,
      normalTemplate: undefined,
      ...(state === "abnormal" ? {} : { selections: [], findingDetails: undefined }),
    }));
  }

  function copyEye(definition: CustomFindingDefinition, from: Eye, to: Eye) {
    const destination = captures[definition.stableKey]?.[to] ?? emptyEye();
    const described = describedFindingNames(abnormalField(definition), destination);
    if (described.length > 0 && !confirmDestroy(described, "Copying the other eye")) return;
    const source = captures[definition.stableKey]?.[from] ?? emptyEye();
    updateEye(definition.stableKey, to, () => {
      return copyEyeCapture(source, definition);
    });
  }

  function setSelections(definition: CustomFindingDefinition, eye: Eye, selections: string[]) {
    const current = captures[definition.stableKey]?.[eye] ?? emptyEye();
    const destroyed = destroyedFindingNames(abnormalField(definition), current, selections);
    if (destroyed.length > 0 && !confirmDestroy(destroyed, "Removing the finding")) return;
    updateEye(definition.stableKey, eye, (capture) => ({
      ...capture,
      selections,
      findingDetails: selectedFindingDetails(capture.findingDetails, selections),
    }));
  }

  function setFindingDetail(
    definition: CustomFindingDefinition,
    eye: Eye,
    optionCode: string,
    qualifierKey: string,
    value: FindingQualifierValue | undefined,
  ) {
    updateEye(definition.stableKey, eye, (current) => ({
      ...current,
      findingDetails: updatedFindingDetails(current.findingDetails, optionCode, qualifierKey, value),
    }));
  }

  function allNormal(prefix: string, label: string) {
    const result = applySegmentAllNormal(definitions, captures, prefix);
    setCaptures(result.captures);
    const { filled, skipped } = result;
    setMessage(`${label}: marked ${filled} untouched ${filled === 1 ? "structure" : "structures"} normal${skipped ? `; skipped ${skipped} already touched` : ""}.`);
  }

  async function save() {
    const dirtyDefinitions = changedDefinitions(definitions, captures, pristine);
    const pending = pendingStateEyes(dirtyDefinitions, captures);
    if (pending.length) {
      setError(pending.map(({ display, eye }) => `${display} (${eye}): choose Normal, Abnormal, or Deferred, or clear the note before saving.`).join(" "));
      setMessage(null);
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (!dirtyDefinitions.length) throw new Error("Capture at least one ocular-health structure before saving.");
      for (const definition of dirtyDefinitions) {
        const field = abnormalField(definition);
        const grades = gradeFields(definition);
        const row = captures[definition.stableKey] ?? emptyRow();
        const eyes = Object.fromEntries(EYES.flatMap((eye) => {
          const capture = row[eye];
          if (!capture.state) return [];
          return [[eye, {
            state: capture.state,
            customFields: [
              ...(capture.state === "abnormal" && field && capture.selections.length
                ? [{ code: field.localCode, value: capture.selections }]
                : []),
              ...(capture.state === "deferred" ? [] : grades.flatMap((grade) => {
                const value = capture.grades?.[grade.localCode] ?? defaultGradeValue(grade);
                return value === "" ? [] : [{
                  code: grade.localCode,
                  value: grade.valueType === "number" ? Number(value) : value,
                }];
              })),
            ],
            ...(hasFindingDetails(capture.findingDetails)
              ? { findingDetails: capture.findingDetails }
              : {}),
            ...(capture.other.trim() ? { other: capture.other.trim() } : {}),
          }]];
        }));
        const response = await fetchImpl(
          `${apiBase ?? clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}`,
          {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ patientReference, encounterReference, eyes }),
          },
        );
        const body = await response.json() as {
          eyes?: Partial<Record<Eye, { observationReference?: string }>>;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? `${definition.display} save failed: ${response.status}`);
        setSavedDiagnosisObservations((current) => ({
          ...current,
          [definition.stableKey]: EYES.flatMap((eye) => {
            const observationReference = body.eyes?.[eye]?.observationReference;
            return row[eye]?.selections.length && observationReference ? [observationReference] : [];
          }),
        }));
        const savedRow = Object.fromEntries(EYES.map((eye) => {
          const capture = row[eye] ?? emptyEye();
          return [eye, {
            ...capture,
            normalTemplate: capture.state === "normal" ? definition.normalTemplate : undefined,
          }];
        })) as Record<Eye, EyeCapture>;
        setPristine((current) => ({ ...current, [definition.stableKey]: savedRow }));
        setCaptures((current) => ({
          ...current,
          [definition.stableKey]: Object.fromEntries(EYES.map((eye) => {
            const capture = current[definition.stableKey]?.[eye] ?? emptyEye();
            return [eye, sameCapture(capture, row[eye] ?? emptyEye()) ? savedRow[eye] : capture];
          })) as Record<Eye, EyeCapture>,
        }));
      }
      const status = {
        completed: true,
        summary: `${dirtyDefinitions.length}/${definitions.length} ocular-health structures saved`,
        savedAt: new Date().toISOString(),
        operator: "ODOS UI ocular health",
      };
      setMessage(status.summary);
      onSaved(status, dirtyDefinitions.map((definition) => definition.stableKey));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-7xl">
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 border-b border-white/10 bg-bg-deep/95 pb-4 backdrop-blur">
          <div><div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">Ocular Health</div><h2 className="mt-1 text-xl font-semibold text-white">Anterior &amp; Posterior Segments</h2><p className="mt-1 text-sm text-white/45">Choose an explicit state for each examined eye. Nothing defaults to normal.</p></div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => allNormal(ANTERIOR_PREFIX, "Anterior All Normal")} disabled={loading} className="rounded border border-emerald-300/50 bg-emerald-300/10 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-300/15 disabled:opacity-40">Anterior All Normal</button>
            <button type="button" onClick={() => allNormal(POSTERIOR_PREFIX, "Fundus All Normal")} disabled={loading} className="rounded border border-emerald-300/50 bg-emerald-300/10 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-300/15 disabled:opacity-40">Fundus All Normal</button>
          </div>
        </div>
        {loading && <div className="py-8 text-sm text-white/45">Loading ocular-health findings…</div>}
        {!loading && <div className={runnerEnabled ? "mt-5 grid items-start gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]" : "mt-5"}>
          {runnerEnabled && highlightedStructureKey && <StructureRail
            groups={groups}
            captures={captures}
            focusedStableKey={highlightedStructureKey}
            onFocus={focusStructure}
          />}
          <div className="space-y-5">{groups.map((group) => <div key={group.label} className="space-y-5">
            <div className="border-b border-white/10 pb-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">{group.label}</div>
            {group.definitions.map((definition) => {
            const field = abnormalField(definition);
            const grades = gradeFields(definition);
            const row = captures[definition.stableKey] ?? emptyRow();
            const prior = priors[definition.stableKey] ?? emptyPriorReadings();
            const diagnosisObservations = savedDiagnosisObservations[definition.stableKey] ?? [];
            const focused = runnerEnabled && definition.stableKey === highlightedStructureKey;
            return (
              <article
                id={domId(definition.stableKey)}
                key={definition.stableKey}
                data-structure-focused={focused || undefined}
                className={`scroll-mt-24 rounded border bg-bg-panel/65 p-4 ${focused ? "border-brand/60 ring-1 ring-brand/30" : "border-white/10"}`}
              >
                <div className="mb-4"><h3 className="font-semibold text-white">{definition.display}</h3></div>
                <div className="grid gap-4 xl:grid-cols-2">{EYES.map((eye) => (
                  <EyePanel
                    key={eye}
                    eye={eye}
                    capture={row[eye]}
                    prior={prior[eye]}
                    field={field}
                    gradeFields={grades}
                    normalTemplate={definition.normalTemplate}
                    allowDeferred={definition.allowDeferred === true}
                    onState={(state) => setExamState(definition, eye, state)}
                    onSelections={(selections) => setSelections(definition, eye, selections)}
                    onFindingDetail={(optionCode, qualifierKey, value) => setFindingDetail(definition, eye, optionCode, qualifierKey, value)}
                    onGrade={(localCode, value) => updateEye(definition.stableKey, eye, (current) => ({ ...current, grades: { ...current.grades, [localCode]: value } }))}
                    onOther={(other) => updateEye(definition.stableKey, eye, (current) => ({ ...current, other }))}
                    onCopy={() => copyEye(definition, eye, eye === "OD" ? "OS" : "OD")}
                  />
                ))}</div>
                {diagnosisObservations.length > 0 && <DiagnosisPicker
                  encounterReference={encounterReference}
                  findingDefinitionKey={definition.stableKey}
                  observationReferences={diagnosisObservations}
                  mode="proposal"
                />}
              </article>
            );
            })}
          </div>)}</div>
        </div>}
        <div className="sticky bottom-0 mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-bg-deep/95 py-4 backdrop-blur">
          <div className="min-h-6 text-sm">{error ? <span className="text-rose-200">{error}</span> : <span className="text-white/55">{message}</span>}</div>
          <button type="button" onClick={save} disabled={saving || loading} className="rounded bg-brand px-5 py-2 text-sm font-semibold text-white disabled:opacity-45">{saving ? "Saving…" : "Save Ocular Health"}</button>
        </div>
      </div>
    </section>
  );
}

function StructureRail({ groups, captures, focusedStableKey, onFocus }: {
  groups: Array<{ label: string; definitions: CustomFindingDefinition[] }>;
  captures: Record<string, Record<Eye, EyeCapture>>;
  focusedStableKey: string;
  onFocus(stableKey: string): void;
}) {
  const definitions = groups.flatMap((group) => group.definitions);
  const focusedIndex = definitions.findIndex((definition) => definition.stableKey === focusedStableKey);
  return (
    <nav
      aria-label="Ocular-health structures"
      data-testid="ocular-health-structure-rail"
      className="max-h-64 overflow-y-auto rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-3 lg:sticky lg:top-28 lg:max-h-[calc(100vh-12rem)]"
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--odos-muted)]">Structures</div>
      <div className="mt-3 space-y-3">
        {groups.map((group) => <div key={group.label} data-structure-rail-group={group.label}>
          <div className="px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-light">{group.label}</div>
          <div className="mt-1 space-y-1">{group.definitions.map((definition) => {
            const state = structureRailState(captures[definition.stableKey] ?? emptyRow());
            const focused = definition.stableKey === focusedStableKey;
            return <button
              type="button"
              key={definition.stableKey}
              data-structure-rail-key={definition.stableKey}
              data-structure-state={state}
              aria-current={focused ? "true" : undefined}
              onClick={() => onFocus(definition.stableKey)}
              className={`flex min-h-9 w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition ${focused ? "bg-brand/20 text-[color:var(--odos-text)] ring-1 ring-brand/45" : "text-[color:var(--odos-muted)] hover:bg-[var(--odos-surface-2)] hover:text-[color:var(--odos-text)]"}`}
            >
              <span className="min-w-0 truncate font-medium">{definition.display}</span>
              <span className="shrink-0 text-[10px] text-[color:var(--odos-muted)]">{state}</span>
            </button>;
          })}</div>
        </div>)}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[color:var(--odos-line)] pt-3">
        <button
          type="button"
          aria-label="Previous ocular-health structure"
          disabled={focusedIndex <= 0}
          onClick={() => onFocus(definitions[focusedIndex - 1]!.stableKey)}
          className="rounded border border-[color:var(--odos-line-2)] px-2 py-2 text-xs font-semibold text-[color:var(--odos-muted)] transition hover:bg-[var(--odos-surface-2)] disabled:opacity-30"
        >
          Prev
        </button>
        <button
          type="button"
          aria-label="Next ocular-health structure"
          disabled={focusedIndex < 0 || focusedIndex >= definitions.length - 1}
          onClick={() => onFocus(definitions[focusedIndex + 1]!.stableKey)}
          className="rounded border border-[color:var(--odos-line-2)] px-2 py-2 text-xs font-semibold text-[color:var(--odos-muted)] transition hover:bg-[var(--odos-surface-2)] disabled:opacity-30"
        >
          Next
        </button>
      </div>
    </nav>
  );
}

function EyePanel({ eye, capture, prior, field, gradeFields, normalTemplate, allowDeferred, onState, onSelections, onFindingDetail, onGrade, onOther, onCopy }: {
  eye: Eye;
  capture: EyeCapture;
  prior: PriorFindingReadings;
  field?: CustomFindingField;
  gradeFields: CustomFindingField[];
  normalTemplate?: string;
  allowDeferred: boolean;
  onState(state: ExamState): void;
  onSelections(selections: string[]): void;
  onFindingDetail(optionCode: string, qualifierKey: string, value: FindingQualifierValue | undefined): void;
  onGrade(localCode: string, value: string): void;
  onOther(other: string): void;
  onCopy(): void;
}) {
  const options = (field?.options ?? []).filter((option) => option.active);
  const parents = options.filter((option) => !option.parentCode);
  const priority = parents.filter((option) => option.priority);
  const additional = parents.filter((option) => !option.priority);
  const worksheetOptions = capture.selections.flatMap((code) => {
    const option = options.find((candidate) => candidate.code === code);
    if (!option) return [];
    const hasChildren = options.some((candidate) => candidate.parentCode === option.code);
    return option.qualifiers?.length || hasChildren ? [option] : [];
  });
  const displayedNormalTemplate = capture.state === "normal" && capture.normalTemplate ? capture.normalTemplate : normalTemplate;
  return (
    <div data-eye-panel={eye} className="rounded border border-white/10 bg-bg-deep/60 p-4">
      <div className="flex items-center justify-between"><span className="text-sm font-semibold text-white">{eye}</span><EyeCopyButton eye={eye} onCopy={onCopy} /></div>
      <div className="mt-3 flex flex-wrap gap-2">
        <StateButton label="Normal" selected={capture.state === "normal"} onClick={() => onState("normal")} />
        <StateButton label="Abnormal" selected={capture.state === "abnormal"} onClick={() => onState("abnormal")} />
        {allowDeferred && <StateButton label="Not performed / deferred" selected={capture.state === "deferred"} onClick={() => onState("deferred")} />}
      </div>
      {displayedNormalTemplate && <p className="mt-3 text-sm text-white/45">{displayedNormalTemplate}</p>}
      {gradeFields.map((grade) => <label key={grade.localCode} className="mt-4 block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-white/45">{grade.display}</span>
        {grade.valueType === "number" ? (
          grade.min !== undefined && grade.max !== undefined && grade.step !== undefined ? <OdosWheel
            value={capture.grades?.[grade.localCode] === undefined ? 0 : Number(capture.grades?.[grade.localCode])}
            centerOn={0}
            min={grade.min}
            max={grade.max}
            step={grade.step}
            format={(value) => formatStepValue(value, grade.step!)}
            onChange={(value) => onGrade(grade.localCode, String(value))}
            ariaLabel={grade.display}
            unit={grade.unit}
            states={[{ value: "", label: "Not recorded" }]}
            selectedState={capture.grades?.[grade.localCode] === undefined ? "" : undefined}
            onStateChange={(value) => onGrade(grade.localCode, value)}
          /> : <div className="flex overflow-hidden rounded border border-white/15 bg-bg-deep focus-within:border-brand">
            <input type="number" value={capture.grades?.[grade.localCode] ?? ""} min={grade.min} max={grade.max} step={grade.step ?? "any"} onChange={(event) => onGrade(grade.localCode, event.target.value)} className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-white outline-none" />
            {grade.unit && <span className="flex items-center border-l border-white/10 px-3 text-sm text-white/45">{grade.unit}</span>}
          </div>
        ) : <OdosSelect
          value={String(capture.grades?.[grade.localCode] ?? defaultGradeValue(grade))}
          options={[
            ...(defaultGradeValue(grade) === "" ? [{ value: "", label: "Select" }] : []),
            ...(grade.options ?? [])
              .filter((option) => option.active)
              .map((option) => ({ value: option.code, label: option.display })),
          ]}
          onChange={(value) => onGrade(grade.localCode, value)}
          ariaLabel={grade.display}
        />}
      </label>)}
      {capture.state === "abnormal" && field && (
        <div className="mt-4 space-y-4">
          <div role="group" aria-label="What is present" className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--odos-muted)]">What is present</div>
            <OptionList ariaLabel="Priority ocular health findings" options={priority} allOptions={options} selected={capture.selections} prior={prior} onChange={onSelections} />
            {additional.length > 0 && <details><summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-[color:var(--odos-muted)]">More findings ({additional.length})</summary><div className="mt-3"><OptionList ariaLabel="Additional ocular health findings" options={additional} allOptions={options} selected={capture.selections} prior={prior} onChange={onSelections} /></div></details>}
          </div>
          {worksheetOptions.length > 0 && (
            <div role="group" aria-label="Describe each" className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--odos-muted)]">Describe each</div>
              {worksheetOptions.map((option) => (
                <FindingWorksheetRow
                  key={option.code}
                  option={option}
                  allOptions={options}
                  capture={capture}
                  prior={prior}
                  onSelections={onSelections}
                  onFindingDetail={onFindingDetail}
                />
              ))}
            </div>
          )}
        </div>
      )}
      <label className="mt-4 block"><span className="mb-1 block text-xs uppercase tracking-wide text-white/35">Other</span><textarea value={capture.other} disabled={!capture.state} onChange={(event) => onOther(event.target.value)} rows={2} className="w-full rounded border border-white/15 bg-bg-deep p-2 text-sm text-white outline-none focus:border-brand disabled:cursor-not-allowed disabled:opacity-45" />{!capture.state && <span className="mt-1 block text-xs text-amber-200/75">Choose an exam state before entering Other.</span>}</label>
    </div>
  );
}

function OptionList({ ariaLabel, options, allOptions, selected, prior, onChange }: {
  ariaLabel: string;
  options: NonNullable<CustomFindingField["options"]>;
  allOptions: NonNullable<CustomFindingField["options"]>;
  selected: string[];
  prior: PriorFindingReadings;
  onChange(selected: string[]): void;
}) {
  const optionCodes = options.map((option) => option.code);
  const presenceOnlyPriors = options.flatMap((option) => {
    const hasChildren = allOptions.some((candidate) => candidate.parentCode === option.code);
    const reading = !option.qualifiers?.length && !hasChildren ? prior[option.code]?.presence : undefined;
    return reading ? [{ option, reading }] : [];
  });
  return (
    <div>
      <OdosChips
        options={options.map((option) => ({ value: option.code, label: findingChipLabel(option.display) }))}
        selected={selected.filter((code) => optionCodes.includes(code))}
        onChange={(nextOptions) => {
          const removedParents = optionCodes.filter((code) => selected.includes(code) && !nextOptions.includes(code));
          const removedChildren = new Set(allOptions
            .filter((option) => option.parentCode && removedParents.includes(option.parentCode))
            .map((option) => option.code));
          onChange(replaceSelectionGroup(selected, optionCodes, nextOptions)
            .filter((code) => !removedChildren.has(code)));
        }}
        ariaLabel={ariaLabel}
      />
      {presenceOnlyPriors.map(({ option, reading }) => (
        <PriorValue key={option.code} reading={reading} value={`${findingChipLabel(option.display)} present`} />
      ))}
    </div>
  );
}

function describedFindingNames(field: CustomFindingField | undefined, capture: EyeCapture): string[] {
  const selected = new Set(capture.selections);
  return (field?.options ?? []).flatMap((option) =>
    selected.has(option.code) && hasRecordedDetails(capture.findingDetails?.[option.code])
      ? [findingChipLabel(option.display)]
      : []
  );
}

function destroyedFindingNames(
  field: CustomFindingField | undefined,
  capture: EyeCapture,
  nextSelections: string[],
): string[] {
  const options = field?.options ?? [];
  const next = new Set(nextSelections);
  return options.flatMap((option) => {
    if (!capture.selections.includes(option.code) || next.has(option.code)) return [];
    const hasSelectedChildren = options.some((candidate) =>
      candidate.parentCode === option.code && capture.selections.includes(candidate.code)
    );
    return hasRecordedDetails(capture.findingDetails?.[option.code]) || hasSelectedChildren
      ? [findingChipLabel(option.display)]
      : [];
  });
}

function hasRecordedDetails(details: Record<string, FindingQualifierValue> | undefined): boolean {
  return details !== undefined && Object.keys(details).length > 0;
}

function confirmDestroy(findings: string[], action: string): boolean {
  const names = [...new Set(findings)].join(", ");
  return window.confirm(`${action} will discard recorded details for ${names}. Continue?`);
}

function StateButton({ label, selected, onClick }: { label: string; selected: boolean; onClick(): void }) {
  return <button type="button" onClick={onClick} className={selected ? "rounded border border-brand/70 bg-brand/20 px-3 py-1.5 text-xs font-semibold text-white" : "rounded border border-white/15 px-3 py-1.5 text-xs text-white/55 hover:border-white/30"}>{label}</button>;
}

function captureFromRows(definition: CustomFindingDefinition, rows: HistoryRow[]): Record<Eye, EyeCapture> {
  const field = abnormalField(definition);
  const grades = gradeFields(definition);
  return Object.fromEntries(EYES.map((eye) => {
    const row = rows.find((candidate) => candidate.eye === eye);
    const value = row?.values.find((candidate) => candidate.code === field?.localCode)?.value;
    return [eye, {
      ...(row?.state ? { state: row.state } : {}),
      selections: Array.isArray(value) ? value : [],
      ...(hasFindingDetails(row?.findingDetails) ? { findingDetails: row.findingDetails } : {}),
      grades: Object.fromEntries(grades.reduce<Array<[string, number | string]>>((values, grade) => {
        const gradeValue = row?.values.find((candidate) => candidate.code === grade.localCode)?.value;
        if (grade.valueType === "number") {
          if (typeof gradeValue === "number") values.push([grade.localCode, gradeValue]);
          return values;
        }
        if (typeof gradeValue !== "string") return values;
        const option = grade.options?.find((candidate) => candidate.code === gradeValue || candidate.display === gradeValue);
        if (option) values.push([grade.localCode, option.code]);
        return values;
      }, [])),
      other: row?.other ?? "",
      ...(row?.normalTemplate ? { normalTemplate: row.normalTemplate } : {}),
    }];
  })) as Record<Eye, EyeCapture>;
}

function diagnosisObservationReferences(definition: CustomFindingDefinition, rows: HistoryRow[]): string[] {
  const field = abnormalField(definition);
  if (!field) return [];
  return EYES.flatMap((eye) => {
    const row = rows.find((candidate) => candidate.eye === eye);
    const selections = row?.values.find((candidate) => candidate.code === field.localCode)?.value;
    return Array.isArray(selections) && selections.length > 0 && row?.observationReference
      ? [row.observationReference]
      : [];
  });
}

function excludeCurrentEncounterRows(patientRows: HistoryRow[], currentRows: HistoryRow[]): HistoryRow[] {
  const currentCounts = new Map<string, number>();
  for (const row of currentRows) {
    const signature = historyRowSignature(row);
    currentCounts.set(signature, (currentCounts.get(signature) ?? 0) + 1);
  }
  return patientRows.filter((row) => {
    const signature = historyRowSignature(row);
    const remaining = currentCounts.get(signature) ?? 0;
    if (remaining === 0) return true;
    currentCounts.set(signature, remaining - 1);
    return false;
  });
}

function historyRowSignature(row: HistoryRow): string {
  return JSON.stringify(row);
}

function rowsBeforeEncounter(rows: HistoryRow[], encounterRecordedAt: string | undefined): HistoryRow[] {
  if (!encounterRecordedAt) return [];
  const encounterTimestamp = Date.parse(encounterRecordedAt);
  if (!Number.isFinite(encounterTimestamp)) return [];
  return rows.filter((row) => {
    const rowTimestamp = Date.parse(row.recordedAt);
    return Number.isFinite(rowTimestamp) && rowTimestamp < encounterTimestamp;
  });
}

function priorReadingsFromRows(
  definition: CustomFindingDefinition,
  rows: HistoryRow[],
): PriorReadings {
  const field = abnormalField(definition);
  if (!field) return emptyPriorReadings();
  const readings = emptyPriorReadings();
  const sortedRows = rows
    .map((row, index) => ({ row, index, timestamp: new Date(row.recordedAt).getTime() }))
    .sort((left, right) => {
      const leftTimestamp = Number.isNaN(left.timestamp) ? Number.NEGATIVE_INFINITY : left.timestamp;
      const rightTimestamp = Number.isNaN(right.timestamp) ? Number.NEGATIVE_INFINITY : right.timestamp;
      return rightTimestamp - leftTimestamp || left.index - right.index;
    })
    .map(({ row }) => row);
  for (const row of sortedRows) {
    if ((row.eye !== "OD" && row.eye !== "OS") || !row.recordedAt) continue;
    const selections = row.values.find((value) => value.code === field.localCode)?.value;
    if (!Array.isArray(selections)) continue;
    for (const optionCode of selections) {
      const option = field.options?.find((candidate) => candidate.code === optionCode);
      if (!option) continue;
      const finding = readings[row.eye][optionCode] ?? { qualifiers: {} };
      finding.presence ??= { recordedAt: row.recordedAt, value: "present" };
      for (const qualifier of option.qualifiers ?? []) {
        const value = row.findingDetails?.[optionCode]?.[qualifier.key];
        if (value !== undefined && finding.qualifiers[qualifier.key] === undefined) {
          finding.qualifiers[qualifier.key] = { recordedAt: row.recordedAt, value };
        }
      }
      readings[row.eye][optionCode] = finding;
    }
  }
  return readings;
}

function emptyPriorReadings(): PriorReadings {
  return { OD: {}, OS: {} };
}

function abnormalField(definition: CustomFindingDefinition): CustomFindingField | undefined {
  return definition.customFields.find((field) => field.active && field.valueType === "multi-select");
}

function gradeFields(definition: CustomFindingDefinition): CustomFindingField[] {
  return definition.customFields.filter((field) => field.active && (field.valueType === "select" || field.valueType === "number"));
}

function defaultGradeValue(field: CustomFindingField): string {
  return field.localCode === "CUSTOM_GRADE_A_V_RATIO"
    ? field.options?.find((option) => option.active)?.code ?? ""
    : "";
}

function emptyCaptures(definitions: CustomFindingDefinition[]) {
  return Object.fromEntries(definitions.map((definition) => [definition.stableKey, emptyRow()]));
}

function emptyRow(): Record<Eye, EyeCapture> {
  return { OD: emptyEye(), OS: emptyEye() };
}

function emptyEye(): EyeCapture {
  return { selections: [], grades: {}, other: "" };
}

function touched(capture: EyeCapture): boolean {
  return Boolean(
    capture.state || capture.other.trim() || capture.selections.length ||
    Object.keys(capture.grades ?? {}).length || hasFindingDetails(capture.findingDetails)
  );
}

function structureRailState(row: Record<Eye, EyeCapture>): string {
  const touchedCaptures = EYES.map((eye) => row[eye]).filter(touched);
  if (touchedCaptures.length === 0) return "blank";
  const findingCount = touchedCaptures.reduce((count, capture) => count + capture.selections.length, 0);
  const unselectedCaptures = touchedCaptures.filter((capture) => capture.selections.length === 0);
  const unselectedStates = [
    ...(unselectedCaptures.some((capture) => capture.state === "abnormal") ? ["abnormal"] : []),
    ...(unselectedCaptures.some((capture) => capture.state === "deferred") ? ["deferred"] : []),
    ...(unselectedCaptures.some((capture) => !capture.state) ? ["incomplete"] : []),
  ];
  if (findingCount > 0) {
    return [`${findingCount} ${findingCount === 1 ? "finding" : "findings"}`, ...unselectedStates].join(" · ");
  }
  return unselectedStates.length > 0 ? unselectedStates.join(" · ") : "normal";
}

export function changedDefinitions<T extends Pick<CustomFindingDefinition, "stableKey">>(
  definitions: T[],
  captures: Record<string, Record<Eye, EyeCapture>>,
  pristine: Record<string, Record<Eye, EyeCapture>>,
): T[] {
  return definitions.filter((definition) => {
    const current = captures[definition.stableKey] ?? emptyRow();
    const baseline = pristine[definition.stableKey] ?? emptyRow();
    return EYES.some((eye) => !sameCapture(current[eye], baseline[eye]));
  });
}

function sameCapture(left: EyeCapture, right: EyeCapture): boolean {
  return left.state === right.state &&
    left.other === right.other &&
    left.normalTemplate === right.normalTemplate &&
    sameGrades(left.grades, right.grades) &&
    sameFindingDetails(left.findingDetails, right.findingDetails) &&
    left.selections.length === right.selections.length &&
    left.selections.every((selection, index) => selection === right.selections[index]);
}

function sameGrades(left: Record<string, number | string> | undefined, right: Record<string, number | string> | undefined): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  return leftEntries.length === rightEntries.length && leftEntries.every(([code, value]) => right?.[code] === value);
}

export function pendingStateEyes(
  definitions: Array<Pick<CustomFindingDefinition, "stableKey" | "display">>,
  captures: Record<string, Record<Eye, EyeCapture>>,
): Array<{ stableKey: string; display: string; eye: Eye }> {
  return definitions.flatMap((definition) => {
    const row = captures[definition.stableKey] ?? emptyRow();
    return EYES.flatMap((eye) => touched(row[eye]) && !row[eye].state
      ? [{ stableKey: definition.stableKey, display: definition.display, eye }]
      : []);
  });
}

export function copyEyeCapture(
  source: EyeCapture,
  _definition: Pick<CustomFindingDefinition, "customFields">,
): EyeCapture {
  return {
    ...source,
    selections: [...source.selections],
    grades: { ...source.grades },
    ...(source.findingDetails
      ? {
          findingDetails: Object.fromEntries(Object.entries(source.findingDetails).map(([optionCode, details]) => [
            optionCode,
            Object.fromEntries(Object.entries(details).map(([qualifierKey, value]) => [
              qualifierKey,
              isClockHourExtentValue(value)
                ? mirrorClockHourExtent(value)
                : value,
            ])),
          ])),
        }
      : {}),
  };
}

export function mirrorClockHourExtent(value: ClockHourExtentValue): ClockHourExtentValue {
  return {
    from: mirrorClockHour(value.from),
    to: mirrorClockHour(value.to),
    clockwise: !value.clockwise,
  };
}

function mirrorClockHour(hour: number): number {
  return (12 - hour) || 12;
}

function sameFindingDetails(left: FindingDetails | undefined, right: FindingDetails | undefined): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

function hasFindingDetails(value: FindingDetails | undefined): value is FindingDetails {
  return value !== undefined && Object.values(value).some((details) => Object.keys(details).length > 0);
}

function selectedFindingDetails(
  findingDetails: FindingDetails | undefined,
  selections: string[],
): FindingDetails | undefined {
  if (!findingDetails) return undefined;
  const selected = new Set(selections);
  const next = Object.fromEntries(
    Object.entries(findingDetails).filter(([optionCode]) => selected.has(optionCode)),
  );
  return hasFindingDetails(next) ? next : undefined;
}

function updatedFindingDetails(
  findingDetails: FindingDetails | undefined,
  optionCode: string,
  qualifierKey: string,
  value: FindingQualifierValue | undefined,
): FindingDetails | undefined {
  const nextOption = { ...(findingDetails?.[optionCode] ?? {}) };
  if (value === undefined) delete nextOption[qualifierKey];
  else nextOption[qualifierKey] = value;
  const next = { ...(findingDetails ?? {}) };
  if (Object.keys(nextOption).length === 0) delete next[optionCode];
  else next[optionCode] = nextOption;
  return hasFindingDetails(next) ? next : undefined;
}

export function applyAnteriorAllNormal(
  definitions: Array<Pick<CustomFindingDefinition, "stableKey">>,
  captures: Record<string, Record<Eye, EyeCapture>>,
): { captures: Record<string, Record<Eye, EyeCapture>>; filled: number; skipped: number } {
  return applySegmentAllNormal(definitions, captures, ANTERIOR_PREFIX);
}

export function applyPosteriorAllNormal(
  definitions: Array<Pick<CustomFindingDefinition, "stableKey">>,
  captures: Record<string, Record<Eye, EyeCapture>>,
): { captures: Record<string, Record<Eye, EyeCapture>>; filled: number; skipped: number } {
  return applySegmentAllNormal(definitions, captures, POSTERIOR_PREFIX);
}

function applySegmentAllNormal(
  definitions: Array<Pick<CustomFindingDefinition, "stableKey">>,
  captures: Record<string, Record<Eye, EyeCapture>>,
  prefix: string,
): { captures: Record<string, Record<Eye, EyeCapture>>; filled: number; skipped: number } {
  let skipped = 0;
  const segmentDefinitions = definitions.filter((definition) =>
    definition.stableKey.startsWith(prefix) ||
    (prefix === ANTERIOR_PREFIX && definition.stableKey === DRY_EYE_ANTERIOR_STABLE_KEY)
  );
  const next = { ...captures };
  for (const definition of segmentDefinitions) {
    const row = captures[definition.stableKey] ?? emptyRow();
    if (touched(row.OD) || touched(row.OS)) {
      skipped += 1;
      next[definition.stableKey] = row;
      continue;
    }
    next[definition.stableKey] = {
      OD: { ...row.OD, state: "normal" as const },
      OS: { ...row.OS, state: "normal" as const },
    };
  }
  return { captures: next, filled: segmentDefinitions.length - skipped, skipped };
}

function segmentGroups(definitions: CustomFindingDefinition[]) {
  return [
    {
      label: "Anterior Segment",
      definitions: definitions.filter((definition) =>
        definition.stableKey.startsWith(ANTERIOR_PREFIX) ||
        definition.stableKey === DRY_EYE_ANTERIOR_STABLE_KEY
      ),
    },
    { label: "Posterior Segment", definitions: definitions.filter((definition) => definition.stableKey.startsWith(POSTERIOR_PREFIX)) },
  ].filter((group) => group.definitions.length > 0);
}

function domId(stableKey: string): string {
  return `structure-${stableKey.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function scrollToStructure(stableKey: string): void {
  document.getElementById(domId(stableKey))?.scrollIntoView({ behavior: "smooth", block: "start" });
}
