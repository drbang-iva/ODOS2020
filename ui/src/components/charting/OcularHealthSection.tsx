import { useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { ClearSectionButton } from "./ClearControls";
import { useEncounterEdit } from "./encounter-edit-context";
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
import { formatDate } from "./PrescriptionSection";
import type { SectionSaveStatus } from "./types";
import { useConfirmDestructive } from "./ConfirmDestructive";

export type Eye = "OD" | "OS";
type ExamState = "normal" | "abnormal" | "deferred";

export interface NegativeAct {
  id: string;
  definitionStableKey: string;
  eye: Eye;
  optionCodes: string[];
  exclusions: string[];
  assertedAt: string;
  actorReference?: string;
}

export interface EyeCapture {
  negativeAct?: NegativeAct;
  state?: ExamState;
  selections: string[];
  grades?: Record<string, number | string>;
  findingDetails?: FindingDetails;
  other: string;
  normalTemplate?: string;
}

interface HistoryRow {
  negativeAct?: NegativeAct;
  observationReference?: string;
  recordedAt: string;
  eye?: Eye;
  state?: ExamState;
  values: Array<{ code: string; label?: string; value: number | string | string[]; unit?: string }>;
  findingDetails?: FindingDetails;
  other?: string;
  normalTemplate?: string;
}

interface CurrentHistory {
  identity: string;
  rowsByStableKey: Record<string, HistoryRow[]>;
}

type PriorReadings = Record<Eye, PriorFindingReadings>;

interface RelatedFindingReading {
  key: string;
  context: "current" | "prior";
  recordedAt: string;
  source: string;
  field: string;
  value: string;
}

type RelatedFindingReadings = Record<Eye, RelatedFindingReading[]>;

interface Props {
  definitions: CustomFindingDefinition[];
  catalogDefinitions?: CustomFindingDefinition[];
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
const MGD_OPTION_CODE = "meibomian-gland-dysfunction";

export function OcularHealthSection({
  definitions,
  catalogDefinitions = [],
  focusedStableKey,
  patientReference,
  encounterReference,
  encounterRecordedAt,
  onSaved,
  apiBase,
  fetchImpl = fetch,
}: Props) {
  const [captures, setCaptures] = useState<Record<string, Record<Eye, EyeCapture>>>(() => emptyCaptures(definitions));
  const currentCaptures = useRef(captures);
  function replaceCaptures(update: typeof captures | ((current: typeof captures) => typeof captures)) {
    const next = typeof update === "function" ? update(currentCaptures.current) : update;
    currentCaptures.current = next;
    setCaptures(next);
  }
  const [pristine, setPristine] = useState<Record<string, Record<Eye, EyeCapture>>>(() => emptyCaptures(definitions));
  const [currentHistory, setCurrentHistory] = useState<CurrentHistory | null>(null);
  const [priors, setPriors] = useState<Record<string, PriorReadings>>({});
  const [relatedReadings, setRelatedReadings] = useState<Record<string, RelatedFindingReadings>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedDiagnosisObservations, setSavedDiagnosisObservations] = useState<Record<string, Partial<Record<Eye, string>>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [failedKeys, setFailedKeys] = useState<string[]>([]);
  const [pendingSavedKeys, setPendingSavedKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const { onCleared } = useEncounterEdit();
  const confirmDestructive = useConfirmDestructive();
  const definitionKey = useMemo(() => definitions.map((definition) => definition.stableKey).join("|"), [definitions]);
  const relatedDefinitions = useMemo(
    () => relatedDefinitionsForTargets(catalogDefinitions, definitions),
    [catalogDefinitions, definitions],
  );
  const relatedDefinitionKey = useMemo(
    () => relatedDefinitions
      .map((definition) => `${definition.stableKey}:${definition.relatedFindingDefinitionKeys?.join(",")}`)
      .join("|"),
    [relatedDefinitions],
  );
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
    setFailedKeys([]);
    setPendingSavedKeys([]);
    setMessage(null);
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
        replaceCaptures(hydrated);
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
  }, [historyIdentity, apiBase, fetchImpl, reloadVersion]);

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
    setRelatedReadings({});
    if (!relatedDefinitions.length) return;
    const controller = new AbortController();
    const base = apiBase ?? clinicalGraphApiBase();
    Promise.all(relatedDefinitions.map(async (definition) => {
      try {
        const endpoint = `${base}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}/history`;
        const currentQuery = new URLSearchParams({ patient: patientReference, encounter: encounterReference });
        const patientQuery = new URLSearchParams({ patient: patientReference });
        const [currentResponse, patientResponse] = await Promise.all([
          fetchImpl(`${endpoint}?${currentQuery}`, { headers: authHeaders(), signal: controller.signal }),
          fetchImpl(`${endpoint}?${patientQuery}`, { headers: authHeaders(), signal: controller.signal }),
        ]);
        const currentBody = await currentResponse.json() as { rows?: HistoryRow[]; error?: string };
        const patientBody = await patientResponse.json() as { rows?: HistoryRow[]; error?: string };
        if (!currentResponse.ok) throw new Error(currentBody.error ?? `${definition.display} current related history failed: ${currentResponse.status}`);
        if (!patientResponse.ok) throw new Error(patientBody.error ?? `${definition.display} related history failed: ${patientResponse.status}`);
        if (currentBody.rows !== undefined && !Array.isArray(currentBody.rows)) throw new Error(`${definition.display} current related history was malformed.`);
        if (patientBody.rows !== undefined && !Array.isArray(patientBody.rows)) throw new Error(`${definition.display} related history was malformed.`);
        const currentRows = currentBody.rows ?? [];
        const priorRows = rowsBeforeEncounter(
          excludeCurrentEncounterRows(patientBody.rows ?? [], currentRows),
          encounterRecordedAt,
        );
        return { definition, currentRows, priorRows };
      } catch (caught) {
        if ((caught as Error).name === "AbortError") throw caught;
        return { definition, currentRows: [], priorRows: [] };
      }
    }))
      .then((sources) => {
        if (!controller.signal.aborted) setRelatedReadings(relatedReadingsByTarget(definitions, sources));
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setRelatedReadings({});
      });
    return () => controller.abort();
  }, [definitionKey, relatedDefinitionKey, patientReference, encounterReference, encounterRecordedAt, apiBase, fetchImpl]);

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
    replaceCaptures((current) => ({
      ...current,
      [stableKey]: {
        ...current[stableKey],
        [eye]: { ...update(current[stableKey]?.[eye] ?? emptyEye()), negativeAct: undefined },
      },
    }));
  }

  function toggleDeferred(definition: CustomFindingDefinition, eye: Eye) {
    const current = captures[definition.stableKey]?.[eye] ?? emptyEye();
    if (current.state === "deferred") {
      updateEye(definition.stableKey, eye, (capture) => ({ ...capture, state: undefined }));
      setError(null);
      return;
    }
    const conflicts = [
      ...(current.selections.length > 0 ? ["the selected findings"] : []),
      ...(current.other.trim() ? ["Other text"] : []),
    ];
    if (conflicts.length > 0) {
      setError(`${definition.display} (${eye}): Clear ${formatList(conflicts)} before deferring.`);
      setMessage(null);
      return;
    }
    updateEye(definition.stableKey, eye, (capture) => ({ ...capture, state: "deferred", normalTemplate: undefined }));
    setError(null);
  }

  async function copyEye(definition: CustomFindingDefinition, from: Eye, to: Eye) {
    const destination = captures[definition.stableKey]?.[to] ?? emptyEye();
    const described = describedFindingNames(abnormalField(definition), destination);
    if (described.length > 0 && !await confirmDestroy(confirmDestructive, described, "Copying the other eye")) return;
    const source = captures[definition.stableKey]?.[from] ?? emptyEye();
    updateEye(definition.stableKey, to, () => {
      return copyEyeCapture(source, definition);
    });
  }

  async function setSelections(definition: CustomFindingDefinition, eye: Eye, selections: string[]) {
    const current = captures[definition.stableKey]?.[eye] ?? emptyEye();
    const destroyed = destroyedFindingNames(abnormalField(definition), current, selections);
    if (destroyed.length > 0 && !await confirmDestroy(confirmDestructive, destroyed, "Removing the finding")) return;
    updateEye(definition.stableKey, eye, (capture) => ({
      ...capture,
      ...(capture.state === "deferred" && selections.length > 0 ? { state: undefined } : {}),
      selections,
      findingDetails: selectedFindingDetails(capture.findingDetails, selections),
    }));
    setError(null);
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
    const dirtyKeys = new Set(changedDefinitions(definitions, captures, pristine).map((definition) => definition.stableKey));
    const currentFailures = failedKeys.filter((key) => dirtyKeys.has(key));
    setFailedKeys(currentFailures);
    if (!currentFailures.length) setError(null);
    const retry = definitions.filter((definition) => currentFailures.includes(definition.stableKey) &&
      (definition.stableKey.startsWith(prefix) || (prefix === ANTERIOR_PREFIX && definition.stableKey === DRY_EYE_ANTERIOR_STABLE_KEY)));
    if (retry.length) return save(retry);
    const result = applySegmentAllNormal(definitions, captures, prefix);
    replaceCaptures(result.captures);
    const { filled, skipped } = result;
    setMessage(`${label}: recorded a negative act for ${filled} untouched ${filled === 1 ? "eye" : "eyes"} (pending save)${skipped ? `; skipped ${skipped} already touched` : ""}.`);
  }

  async function save(onlyDefinitions = definitions) {
    const dirtyDefinitions = changedDefinitions(onlyDefinitions, captures, pristine);
    let persistedCaptures = pristine;
    const failures: string[] = [];
    const successfulKeys: string[] = [];
    const failureNames: string[] = [];
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (!dirtyDefinitions.length && !failedKeys.length && !pendingSavedKeys.length) throw new Error("Capture at least one ocular-health structure before saving.");
      for (const definition of dirtyDefinitions) {
        try {
          const field = abnormalField(definition);
          const grades = gradeFields(definition);
          const row = captures[definition.stableKey] ?? emptyRow();
          const eyes = Object.fromEntries(EYES.flatMap((eye) => {
            const capture = row[eye];
            const original = pristine[definition.stableKey]?.[eye] ?? emptyEye();
            if (sameCapture(capture, original)) return [];
            const state = derivedExamState(capture);
            return [[eye, {
              state,
              ...(capture.negativeAct ? { negativeAct: {
                id: capture.negativeAct.id,
                definitionStableKey: capture.negativeAct.definitionStableKey,
                eye: capture.negativeAct.eye,
                optionCodes: capture.negativeAct.optionCodes,
                exclusions: capture.negativeAct.exclusions,
                assertedAt: capture.negativeAct.assertedAt,
              } } : {}),
              customFields: [
                ...(field && capture.selections.length
                  ? [{ code: field.localCode, value: capture.selections }]
                  : []),
                ...(state === "deferred" ? [] : grades.flatMap((grade) => {
                  const value = capture.grades?.[grade.localCode] ?? "";
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
            eyes?: Partial<Record<Eye, { observationReference?: string; negativeAct?: NegativeAct }>>;
            error?: string;
          };
          if (!response.ok) throw new Error(body.error ?? `${definition.display} save failed: ${response.status}`);
          setSavedDiagnosisObservations((current) => ({
            ...current,
            [definition.stableKey]: Object.fromEntries(EYES.flatMap((eye) => {
              const observationReference = body.eyes?.[eye]?.observationReference ?? current[definition.stableKey]?.[eye];
              return row[eye]?.selections.length && observationReference ? [[eye, observationReference]] : [];
            })),
          }));
          const savedRow = Object.fromEntries(EYES.map((eye) => {
            const capture = row[eye] ?? emptyEye();
            const original = pristine[definition.stableKey]?.[eye] ?? emptyEye();
            const state = touched(capture) || touched(original) ? derivedExamState(capture) : capture.state;
            return [eye, {
              ...capture,
              ...(body.eyes?.[eye]?.negativeAct ? { negativeAct: body.eyes[eye]!.negativeAct } : {}),
              state,
              normalTemplate: state === "normal" ? definition.normalTemplate : undefined,
            }];
          })) as Record<Eye, EyeCapture>;
          persistedCaptures = { ...persistedCaptures, [definition.stableKey]: savedRow };
          setPristine(persistedCaptures);
          replaceCaptures((current) => ({
            ...current,
            [definition.stableKey]: Object.fromEntries(EYES.map((eye) => {
              const capture = current[definition.stableKey]?.[eye] ?? emptyEye();
              return [eye, sameCapture(capture, row[eye] ?? emptyEye()) ? savedRow[eye] : capture];
            })) as Record<Eye, EyeCapture>,
          }));
          successfulKeys.push(definition.stableKey);
        } catch (caught) {
          failures.push(definition.stableKey);
          failureNames.push(`${definition.display} (${caught instanceof Error ? caught.message : String(caught)})`);
        }
      }
      const dirtyKeys = new Set(changedDefinitions(definitions, currentCaptures.current, persistedCaptures).map((definition) => definition.stableKey));
      const unattemptedFailures = failedKeys.filter((key) => dirtyKeys.has(key) && !dirtyDefinitions.some((definition) => definition.stableKey === key));
      const remainingFailures = [...unattemptedFailures, ...failures];
      const remainingFailureNames = [...unattemptedFailures.map((key) => definitions.find((definition) => definition.stableKey === key)!.display), ...failureNames];
      const allSavedKeys = [...new Set([...pendingSavedKeys, ...successfulKeys])];
      setPendingSavedKeys(allSavedKeys);
      setFailedKeys(remainingFailures);
      if (remainingFailures.length) {
        setError(`Failed: ${remainingFailureNames.join("; ")}. ${allSavedKeys.length} structures saved; retry only the failed structures with All Normal or Save.`);
        return;
      }
      const unsavedDefinitions = definitions.filter((definition) => dirtyKeys.has(definition.stableKey));
      if (unsavedDefinitions.length) {
        setMessage(`Unsaved changes: ${unsavedDefinitions.map((definition) => definition.display).join("; ")}. Use Save Ocular Health to persist these edits.`);
        return;
      }
      if (!allSavedKeys.length) {
        setMessage("No unsaved changes.");
        return;
      }
      const status = {
        completed: true,
        summary: `${allSavedKeys.length}/${definitions.length} ocular-health structures saved`,
        savedAt: new Date().toISOString(),
        operator: "ODOS UI ocular health",
      };
      setMessage(status.summary);
      onSaved(status, allSavedKeys);
      setPendingSavedKeys([]);
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
          <div><div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">Ocular Health</div><h2 className="mt-1 text-xl font-semibold text-white">Anterior &amp; Posterior Segments</h2><p className="mt-1 text-sm text-white/45">Record what is present. Unmarked structures save as normal when touched.</p></div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => allNormal(ANTERIOR_PREFIX, "Anterior All Normal")} disabled={loading || saving} className="rounded border border-[color:var(--odos-accent-border)] bg-[color:var(--odos-accent-tint-lo)] px-4 py-2 text-sm font-semibold text-[color:var(--odos-accent-hi)] hover:bg-[color:var(--odos-accent-tint-hi)] disabled:opacity-40">Anterior All Normal</button>
            <button type="button" onClick={() => allNormal(POSTERIOR_PREFIX, "Fundus All Normal")} disabled={loading || saving} className="rounded border border-[color:var(--odos-accent-border)] bg-[color:var(--odos-accent-tint-lo)] px-4 py-2 text-sm font-semibold text-[color:var(--odos-accent-hi)] hover:bg-[color:var(--odos-accent-tint-hi)] disabled:opacity-40">Fundus All Normal</button>
            <ClearSectionButton
              encounterReference={encounterReference}
              sectionKey={definitions.map((definition) => definition.stableKey)}
              label="Ocular Health"
              hasRecorded={Object.values(currentHistory?.rowsByStableKey ?? {}).some((rows) => rows.length > 0)}
              fetchImpl={fetchImpl}
              onCleared={(result) => {
                setMessage(null);
                setReloadVersion((current) => current + 1);
                onCleared?.({ scope: "section", result });
              }}
            />
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
            const related = relatedReadings[definition.stableKey] ?? emptyRelatedReadings();
            const diagnosisObservations = Object.values(savedDiagnosisObservations[definition.stableKey] ?? {});
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
                    related={related[eye]}
                    field={field}
                    gradeFields={grades}
                    normalTemplate={definition.normalTemplate}
                    allowDeferred={definition.allowDeferred === true}
                    onDeferred={() => toggleDeferred(definition, eye)}
                    onSelections={(selections) => setSelections(definition, eye, selections)}
                    onFindingDetail={(optionCode, qualifierKey, value) => setFindingDetail(definition, eye, optionCode, qualifierKey, value)}
                    onGrade={(localCode, value) => updateEye(definition.stableKey, eye, (current) => {
                      const grades = { ...current.grades, [localCode]: value };
                      if (localCode === "CUSTOM_GRADE_A_V_RATIO" && value === "") delete grades[localCode];
                      return { ...current, grades };
                    })}
                    onOther={(other) => {
                      updateEye(definition.stableKey, eye, (current) => ({
                        ...current,
                        ...(current.state === "deferred" && other.trim() ? { state: undefined } : {}),
                        other,
                      }));
                      setError(null);
                    }}
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
          <button type="button" onClick={() => save()} disabled={saving || loading} className="rounded bg-brand px-5 py-2 text-sm font-semibold text-white disabled:opacity-45">{saving ? "Saving…" : "Save Ocular Health"}</button>
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

function EyePanel({ eye, capture, prior, related, field, gradeFields, normalTemplate, allowDeferred, onDeferred, onSelections, onFindingDetail, onGrade, onOther, onCopy }: {
  eye: Eye;
  capture: EyeCapture;
  prior: PriorFindingReadings;
  related: RelatedFindingReading[];
  field?: CustomFindingField;
  gradeFields: CustomFindingField[];
  normalTemplate?: string;
  allowDeferred: boolean;
  onDeferred(): void;
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
      {allowDeferred && <div className="mt-3"><button
        type="button"
        aria-pressed={capture.state === "deferred"}
        onClick={onDeferred}
        className={capture.state === "deferred" ? "rounded border border-brand/70 bg-brand/20 px-3 py-1.5 text-xs font-semibold text-white" : "rounded border border-white/15 px-3 py-1.5 text-xs text-white/55 hover:border-white/30"}
      >Not performed / deferred</button></div>}
      {capture.negativeAct ? <details className="mt-3 text-sm text-white/65" data-negative-act={capture.negativeAct.id}>
        <summary>{capture.negativeAct.optionCodes.length} findings explicitly asserted absent{capture.negativeAct.actorReference ? "" : " · pending save"}</summary>
        <p>{capture.negativeAct.assertedAt}{capture.negativeAct.actorReference ? ` · ${capture.negativeAct.actorReference}` : " · pending save"}</p>
        <p>Absent: {capture.negativeAct.optionCodes.map((code) => options.find((option) => option.code === code)?.display ?? code).join(", ") || "None"}</p>
        <p>Excluded: {capture.negativeAct.exclusions.join(", ") || "None"}</p>
        <p>Not covered: {options.filter((option) => !capture.negativeAct!.optionCodes.includes(option.code)).map((option) => option.display).join(", ") || "None"}</p>
      </details> : <p className="mt-3 text-xs text-white/45">No explicit negative assertion recorded</p>}
      {displayedNormalTemplate && <p className="mt-3 text-sm text-white/45">{displayedNormalTemplate}</p>}
      {gradeFields.map((grade) => <label key={grade.localCode} className="mt-4 block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-white/45">{grade.display}</span>
        {grade.valueType === "number" ? (
          grade.min !== undefined && grade.max !== undefined && grade.step !== undefined ? <OdosWheel
            value={capture.grades?.[grade.localCode] === undefined ? null : Number(capture.grades?.[grade.localCode])}
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
          value={String(capture.grades?.[grade.localCode] ?? "")}
          options={[
            { value: "", label: "Select" },
            ...(grade.options ?? [])
              .filter((option) => option.active)
              .map((option) => ({ value: option.code, label: option.display })),
          ]}
          onChange={(value) => onGrade(grade.localCode, value)}
          ariaLabel={grade.display}
        />}
      </label>)}
      {field && (
        <div className="mt-4 space-y-4">
          <div role="group" aria-label="What is present" className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--odos-muted)]">What is present</div>
            <OptionList ariaLabel="Priority ocular health findings" options={priority} allOptions={options} selected={capture.selections} prior={prior} related={related} onChange={onSelections} />
            {additional.length > 0 && <OptionList ariaLabel="Additional ocular health findings" options={additional} allOptions={options} selected={capture.selections} prior={prior} related={related} onChange={onSelections} />}
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
      <label className="mt-4 block"><span className="mb-1 block text-xs uppercase tracking-wide text-white/35">Other</span><textarea value={capture.other} onChange={(event) => onOther(event.target.value)} rows={2} className="w-full rounded border border-white/15 bg-bg-deep p-2 text-sm text-white outline-none focus:border-brand" /></label>
    </div>
  );
}

function OptionList({ ariaLabel, options, allOptions, selected, prior, related, onChange }: {
  ariaLabel: string;
  options: NonNullable<CustomFindingField["options"]>;
  allOptions: NonNullable<CustomFindingField["options"]>;
  selected: string[];
  prior: PriorFindingReadings;
  related: RelatedFindingReading[];
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
      {options.some((option) => option.code === MGD_OPTION_CODE) && related.map((reading) => (
        <div key={reading.key} data-related-finding-reading="" className="mt-1 text-xs font-normal text-[color:var(--odos-faint)]">
          {reading.context === "current" ? "This visit" : "Prior"}: {reading.source} · {reading.field}: {reading.value} · {formatDate(reading.recordedAt)}
        </div>
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

function confirmDestroy(confirmDestructive: ReturnType<typeof useConfirmDestructive>, findings: string[], action: string): Promise<boolean> {
  const names = [...new Set(findings)].join(", ");
  return confirmDestructive({
    title: `${action} will discard recorded details for ${names}. Continue?`,
    consequence: "",
    confirmLabel: "Continue",
  });
}

function captureFromRows(definition: CustomFindingDefinition, rows: HistoryRow[]): Record<Eye, EyeCapture> {
  const field = abnormalField(definition);
  const grades = gradeFields(definition);
  return Object.fromEntries(EYES.map((eye) => {
    const row = rows.find((candidate) => candidate.eye === eye);
    const value = row?.values.find((candidate) => candidate.code === field?.localCode)?.value;
    return [eye, {
      ...(row?.state ? { state: row.state } : {}),
      ...(row?.negativeAct ? { negativeAct: row.negativeAct } : {}),
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

function diagnosisObservationReferences(definition: CustomFindingDefinition, rows: HistoryRow[]): Partial<Record<Eye, string>> {
  const field = abnormalField(definition);
  if (!field) return {};
  return Object.fromEntries(EYES.flatMap((eye) => {
    const row = rows.find((candidate) => candidate.eye === eye);
    const selections = row?.values.find((candidate) => candidate.code === field.localCode)?.value;
    return Array.isArray(selections) && selections.length > 0 && row?.observationReference
      ? [[eye, row.observationReference]]
      : [];
  }));
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

export function relatedDefinitionsForTargets(
  catalogDefinitions: CustomFindingDefinition[],
  targetDefinitions: Array<Pick<CustomFindingDefinition, "stableKey"> & Partial<Pick<CustomFindingDefinition, "customFields">>>,
): CustomFindingDefinition[] {
  const targetKeys = new Set(targetDefinitions.map((definition) => definition.stableKey));
  return catalogDefinitions.filter((definition) =>
    definition.active && definition.relatedFindingDefinitionKeys?.some((stableKey) => targetKeys.has(stableKey))
  );
}

function relatedReadingsByTarget(
  targetDefinitions: Array<Pick<CustomFindingDefinition, "stableKey"> & Partial<Pick<CustomFindingDefinition, "customFields">>>,
  sources: Array<{
    definition: CustomFindingDefinition;
    currentRows: HistoryRow[];
    priorRows: HistoryRow[];
  }>,
): Record<string, RelatedFindingReadings> {
  const targetKeys = new Set(targetDefinitions.map((definition) => definition.stableKey));
  const readings = Object.fromEntries(
    targetDefinitions.map((definition) => [definition.stableKey, emptyRelatedReadings()]),
  ) as Record<string, RelatedFindingReadings>;
  for (const { definition, currentRows, priorRows } of sources) {
    const source = relatedSourceLabel(definition);
    for (const targetKey of definition.relatedFindingDefinitionKeys ?? []) {
      if (!targetKeys.has(targetKey)) continue;
      const target = readings[targetKey] ?? emptyRelatedReadings();
      for (const eye of EYES) {
        for (const [context, rows] of [["current", currentRows], ["prior", priorRows]] as const) {
          const sortedRows = rows
            .filter((row) => Number.isFinite(Date.parse(row.recordedAt)))
            .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt));
          const eyeRows = sortedRows.filter((row) => row.eye === eye);
          const latestCurrentRow = context === "current" ? eyeRows[0] : undefined;
          for (const field of definition.customFields.filter((candidate) => candidate.active).sort((left, right) => left.order - right.order)) {
            const row = latestCurrentRow ?? eyeRows.find((candidate) =>
              candidate.values.some((value) => value.code === field.localCode)
            );
            const stored = row?.values.find((value) => value.code === field.localCode);
            if (!row || !stored) continue;
            const value = formatRelatedValue(field, stored.value, stored.unit);
            if (!value) continue;
            target[eye].push({
              key: `${definition.stableKey}:${eye}:${context}:${field.localCode}`,
              context,
              recordedAt: row.recordedAt,
              source,
              field: stored.label ?? field.display,
              value,
            });
          }
        }
      }
      readings[targetKey] = target;
    }
  }
  return readings;
}

function emptyRelatedReadings(): RelatedFindingReadings {
  return { OD: [], OS: [] };
}

function relatedSourceLabel(definition: CustomFindingDefinition): string {
  const namespace = (definition.sectionKey ?? definition.stableKey).split(":")[0];
  const group = namespace.includes("-") ? findingChipLabel(namespace.replaceAll("-", " ")) : undefined;
  return group ? `${group} · ${definition.display}` : definition.display;
}

function formatRelatedValue(
  field: CustomFindingField,
  value: number | string | string[],
  storedUnit: string | undefined,
): string {
  const unit = storedUnit ?? field.unit;
  if (Array.isArray(value)) {
    return value.map((entry) => field.options?.find((option) => option.code === entry)?.display ?? findingChipLabel(entry)).join(", ");
  }
  if (typeof value === "number") {
    const formatted = field.step === undefined ? String(value) : formatStepValue(value, field.step);
    return `${formatted}${unit ? ` ${unit}` : ""}`;
  }
  if (!value.trim()) return "";
  return field.options?.find((option) => option.code === value)?.display ?? findingChipLabel(value);
}

function abnormalField(definition: CustomFindingDefinition): CustomFindingField | undefined {
  return definition.customFields.find((field) => field.active && field.valueType === "multi-select");
}

function gradeFields(definition: CustomFindingDefinition): CustomFindingField[] {
  return definition.customFields.filter((field) => field.active && (field.valueType === "select" || field.valueType === "number"));
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

function derivedExamState(capture: EyeCapture): ExamState {
  if (capture.state === "deferred") return "deferred";
  return capture.selections.length > 0 || Boolean(capture.other.trim()) ? "abnormal" : "normal";
}

function formatList(values: string[]): string {
  return values.length === 2 ? `${values[0]} and ${values[1]}` : values[0] ?? "recorded findings";
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
  return JSON.stringify(left.negativeAct) === JSON.stringify(right.negativeAct) &&
    left.state === right.state &&
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

export function copyEyeCapture(
  source: EyeCapture,
  _definition: Pick<CustomFindingDefinition, "customFields">,
): EyeCapture {
  return {
    ...source,
    negativeAct: undefined,
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
  definitions: Array<Pick<CustomFindingDefinition, "stableKey"> & Partial<Pick<CustomFindingDefinition, "customFields">>>,
  captures: Record<string, Record<Eye, EyeCapture>>,
): { captures: Record<string, Record<Eye, EyeCapture>>; filled: number; skipped: number } {
  return applySegmentAllNormal(definitions, captures, ANTERIOR_PREFIX);
}

export function applyPosteriorAllNormal(
  definitions: Array<Pick<CustomFindingDefinition, "stableKey"> & Partial<Pick<CustomFindingDefinition, "customFields">>>,
  captures: Record<string, Record<Eye, EyeCapture>>,
): { captures: Record<string, Record<Eye, EyeCapture>>; filled: number; skipped: number } {
  return applySegmentAllNormal(definitions, captures, POSTERIOR_PREFIX);
}

function applySegmentAllNormal(
  definitions: Array<Pick<CustomFindingDefinition, "stableKey"> & Partial<Pick<CustomFindingDefinition, "customFields">>>,
  captures: Record<string, Record<Eye, EyeCapture>>,
  prefix: string,
): { captures: Record<string, Record<Eye, EyeCapture>>; filled: number; skipped: number } {
  let skipped = 0;
  let filled = 0;
  const segmentDefinitions = definitions.filter((definition) =>
    (definition.stableKey.startsWith(prefix) ||
      (prefix === ANTERIOR_PREFIX && definition.stableKey === DRY_EYE_ANTERIOR_STABLE_KEY))
  );
  const next = { ...captures };
  for (const definition of segmentDefinitions) {
    const field = definition.customFields?.find((field) =>
      field.valueType === "multi-select" && field.options?.some((option) => option.active)
    );
    if (!field) continue;
    const optionCodes = (field.options ?? []).filter((option) => option.active).map((option) => option.code);
    const row = captures[definition.stableKey] ?? emptyRow();
    next[definition.stableKey] = { ...row };
    for (const eye of EYES) {
      if (touched(row[eye])) { skipped += 1; continue; }
      next[definition.stableKey]![eye] = { ...row[eye], state: "normal", negativeAct: {
        id: crypto.randomUUID(), definitionStableKey: definition.stableKey, eye,
        optionCodes, exclusions: [], assertedAt: new Date().toISOString(),
      } };
      filled += 1;
    }
  }
  return { captures: next, filled, skipped };
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
