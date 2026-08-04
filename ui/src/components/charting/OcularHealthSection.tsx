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
  FindingQualifierDefinition,
  FindingQualifierValue,
} from "./CustomFindingSection";
import { EyeCopyButton } from "./EyeCopyButton";
import { formatStepValue } from "./power-options";
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
  eye?: Eye;
  state?: ExamState;
  values: Array<{ code: string; value: number | string | string[] }>;
  findingDetails?: FindingDetails;
  other?: string;
  normalTemplate?: string;
}

interface Props {
  definitions: CustomFindingDefinition[];
  focusedStableKey?: string;
  patientReference: string;
  encounterReference: string;
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
  onSaved,
  apiBase,
  fetchImpl = fetch,
}: Props) {
  const [captures, setCaptures] = useState<Record<string, Record<Eye, EyeCapture>>>(() => emptyCaptures(definitions));
  const [pristine, setPristine] = useState<Record<string, Record<Eye, EyeCapture>>>(() => emptyCaptures(definitions));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const definitionKey = useMemo(() => definitions.map((definition) => definition.stableKey).join("|"), [definitions]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const base = apiBase ?? clinicalGraphApiBase();
    Promise.all(definitions.map(async (definition) => {
      const query = new URLSearchParams({ patient: patientReference, encounter: encounterReference });
      const response = await fetchImpl(
        `${base}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}/history?${query}`,
        { headers: authHeaders(), signal: controller.signal },
      );
      const body = await response.json() as { rows?: HistoryRow[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `${definition.display} history failed: ${response.status}`);
      return [definition.stableKey, captureFromRows(definition, body.rows ?? [])] as const;
    }))
      .then((rows) => {
        const hydrated = Object.fromEntries(rows);
        setCaptures(hydrated);
        setPristine(hydrated);
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [definitionKey, patientReference, encounterReference, apiBase, fetchImpl]);

  useEffect(() => {
    if (!focusedStableKey) return;
    document.getElementById(domId(focusedStableKey))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusedStableKey]);

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
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error ?? `${definition.display} save failed: ${response.status}`);
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
        {!loading && <div className="mt-5 space-y-5">{segmentGroups(definitions).map((group) => <div key={group.label} className="space-y-5">
          <div className="border-b border-white/10 pb-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">{group.label}</div>
          {group.definitions.map((definition) => {
          const field = abnormalField(definition);
          const grades = gradeFields(definition);
          const row = captures[definition.stableKey] ?? emptyRow();
          return (
            <article id={domId(definition.stableKey)} key={definition.stableKey} className="scroll-mt-24 rounded border border-white/10 bg-bg-panel/65 p-4">
              <div className="mb-4"><h3 className="font-semibold text-white">{definition.display}</h3></div>
              <div className="grid gap-4 xl:grid-cols-2">{EYES.map((eye) => (
                <EyePanel
                  key={eye}
                  eye={eye}
                  capture={row[eye]}
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
            </article>
          );
          })}
        </div>)}</div>}
        <div className="sticky bottom-0 mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-bg-deep/95 py-4 backdrop-blur">
          <div className="min-h-6 text-sm">{error ? <span className="text-rose-200">{error}</span> : <span className="text-white/55">{message}</span>}</div>
          <button type="button" onClick={save} disabled={saving || loading} className="rounded bg-brand px-5 py-2 text-sm font-semibold text-white disabled:opacity-45">{saving ? "Saving…" : "Save Ocular Health"}</button>
        </div>
      </div>
    </section>
  );
}

function EyePanel({ eye, capture, field, gradeFields, normalTemplate, allowDeferred, onState, onSelections, onFindingDetail, onGrade, onOther, onCopy }: {
  eye: Eye;
  capture: EyeCapture;
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
    <div className="rounded border border-white/10 bg-bg-deep/60 p-4">
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
            <OptionList ariaLabel="Priority ocular health findings" options={priority} allOptions={options} selected={capture.selections} onChange={onSelections} />
            {additional.length > 0 && <details><summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-[color:var(--odos-muted)]">More findings ({additional.length})</summary><div className="mt-3"><OptionList ariaLabel="Additional ocular health findings" options={additional} allOptions={options} selected={capture.selections} onChange={onSelections} /></div></details>}
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

function OptionList({ ariaLabel, options, allOptions, selected, onChange }: {
  ariaLabel: string;
  options: NonNullable<CustomFindingField["options"]>;
  allOptions: NonNullable<CustomFindingField["options"]>;
  selected: string[];
  onChange(selected: string[]): void;
}) {
  const optionCodes = options.map((option) => option.code);
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
    </div>
  );
}

type FindingOption = NonNullable<CustomFindingField["options"]>[number];

function FindingWorksheetRow({ option, allOptions, capture, onSelections, onFindingDetail }: {
  option: FindingOption;
  allOptions: FindingOption[];
  capture: EyeCapture;
  onSelections(selections: string[]): void;
  onFindingDetail(optionCode: string, qualifierKey: string, value: FindingQualifierValue | undefined): void;
}) {
  const children = allOptions.filter((candidate) => candidate.parentCode === option.code);
  const childCodes = children.map((child) => child.code);
  const controls = [
    ...(option.qualifiers ?? []).map((qualifier) => (
      <FindingQualifierControl
        key={qualifier.key}
        qualifier={qualifier}
        value={capture.findingDetails?.[option.code]?.[qualifier.key]}
        onChange={(value) => onFindingDetail(option.code, qualifier.key, value)}
      />
    )),
    ...(children.length > 0 ? [(
      <div key="children" className="min-w-0">
        <div className="mb-1 text-xs font-semibold text-[color:var(--odos-muted)]">Details</div>
        <OdosChips
          options={children.map((child) => ({ value: child.code, label: findingChipLabel(child.display) }))}
          selected={capture.selections.filter((code) => childCodes.includes(code))}
          onChange={(nextChildren) => onSelections(replaceSelectionGroup(capture.selections, childCodes, nextChildren))}
          ariaLabel={`${option.display} details`}
        />
      </div>
    )] : []),
  ];
  const removeCodes = new Set([option.code, ...childCodes]);
  return (
    <div data-finding-row={option.code} className="grid gap-3 rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface-2)] p-3 md:grid-cols-[minmax(8rem,0.7fr)_minmax(0,2fr)_auto]">
      <div className="flex min-h-11 items-center text-sm font-semibold text-[color:var(--odos-text)]">{findingChipLabel(option.display)}</div>
      {controls.length > 0 && <div data-finding-controls={option.code} className="grid gap-3 sm:grid-cols-2">{controls}</div>}
      <button
        type="button"
        aria-label={`Remove ${option.display}`}
        onClick={() => onSelections(capture.selections.filter((code) => !removeCodes.has(code)))}
        className="min-h-11 min-w-11 justify-self-end rounded border border-[color:var(--odos-line-2)] text-[color:var(--odos-muted)] outline-none hover:bg-[var(--odos-surface-3)] hover:text-[color:var(--odos-text)] focus-visible:border-brand"
      >
        ×
      </button>
    </div>
  );
}

function FindingQualifierControl({ qualifier, value, onChange }: {
  qualifier: FindingQualifierDefinition;
  value: FindingQualifierValue | undefined;
  onChange(value: FindingQualifierValue | undefined): void;
}) {
  if (qualifier.kind === "graded") {
    const selected = typeof value === "string" ? [value] : [];
    return (
      <div className="min-w-0">
        <div className="mb-1 text-xs font-semibold text-[color:var(--odos-muted)]">{qualifier.display}</div>
        <OdosChips
          options={qualifier.options.map((option) => ({ value: option, label: findingChipLabel(option) }))}
          selected={selected}
          onChange={(next) => onChange(next[0])}
          ariaLabel={qualifier.display}
          exclusive
        />
      </div>
    );
  }
  if (qualifier.kind === "enum") {
    const selected = typeof value === "string" ? [value] : [];
    return (
      <div className="min-w-0">
        <div className="mb-1 text-xs font-semibold text-[color:var(--odos-muted)]">{qualifier.display}</div>
        <OdosChips
          options={qualifier.options.map((option) => ({ value: option.code, label: option.display }))}
          selected={selected}
          onChange={(next) => onChange(next[0])}
          ariaLabel={qualifier.display}
          exclusive
        />
      </div>
    );
  }
  if (qualifier.kind === "numeric") {
    return <NumericFindingQualifier qualifier={qualifier} value={typeof value === "number" ? value : undefined} onChange={onChange} />;
  }
  const extent = isClockHourExtentValue(value) ? value : undefined;
  const hours = [
    { value: "", label: "Not recorded" },
    ...Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) })),
  ];
  const updateHour = (key: "from" | "to", next: string) => {
    if (next === "") {
      onChange(undefined);
      return;
    }
    const hour = Number(next);
    onChange(extent ? { ...extent, [key]: hour } : { from: hour, to: hour, clockwise: true });
  };
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-semibold text-[color:var(--odos-muted)]">{qualifier.display}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <OdosSelect value={extent ? String(extent.from) : ""} options={hours} onChange={(next) => updateHour("from", next)} ariaLabel={`${qualifier.display} from clock hour`} />
        <OdosSelect value={extent ? String(extent.to) : ""} options={hours} onChange={(next) => updateHour("to", next)} ariaLabel={`${qualifier.display} to clock hour`} />
      </div>
      {extent && <div className="mt-2"><OdosChips
        options={[{ value: true, label: "Clockwise" }, { value: false, label: "Counterclockwise" }]}
        selected={[extent.clockwise]}
        onChange={(next) => { if (next.length) onChange({ ...extent, clockwise: next[0]! }); }}
        ariaLabel={`${qualifier.display} direction`}
        exclusive
      /></div>}
    </div>
  );
}

function NumericFindingQualifier({ qualifier, value, onChange }: {
  qualifier: Extract<FindingQualifierDefinition, { kind: "numeric" }>;
  value: number | undefined;
  onChange(value: number | undefined): void;
}) {
  const storedText = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(storedText);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(storedText);
    setValidationError(null);
  }, [storedText]);

  const commit = () => {
    if (draft === "") {
      onChange(undefined);
      setValidationError(null);
      return;
    }
    const parsed = Number(draft);
    const stepPosition = (parsed - qualifier.min) / qualifier.step;
    if (!Number.isFinite(parsed) || parsed < qualifier.min || parsed > qualifier.max ||
      Math.abs(stepPosition - Math.round(stepPosition)) > 1e-9) {
      setDraft(storedText);
      setValidationError(`${qualifier.display} must be between ${qualifier.min} and ${qualifier.max} in increments of ${qualifier.step}.`);
      return;
    }
    onChange(parsed);
    setDraft(String(parsed));
    setValidationError(null);
  };

  return (
    <label className="min-w-0">
      <span className="mb-1 block text-xs font-semibold text-[color:var(--odos-muted)]">{qualifier.display}</span>
      <div className={`flex min-h-11 overflow-hidden rounded border bg-bg-deep focus-within:border-brand ${validationError ? "border-[color:var(--odos-alert)]" : "border-[color:var(--odos-line-2)]"}`}>
        <input
          type="text"
          inputMode="decimal"
          aria-label={qualifier.display}
          aria-invalid={validationError ? true : undefined}
          value={draft}
          min={qualifier.min}
          max={qualifier.max}
          step={qualifier.step}
          onChange={(event) => {
            setDraft(event.target.value);
            setValidationError(null);
          }}
          onBlur={commit}
          className="min-h-11 min-w-0 flex-1 bg-transparent px-3 text-sm text-[color:var(--odos-text)] outline-none"
        />
        {qualifier.unit && <span className="flex min-h-11 items-center border-l border-[color:var(--odos-line)] px-3 text-sm text-[color:var(--odos-muted)]">{qualifier.unit}</span>}
      </div>
      {validationError && <span role="alert" className="mt-1 block text-xs text-[color:var(--odos-alert)]">{validationError}</span>}
    </label>
  );
}

function findingChipLabel(display: string): string {
  return display.replace(/(^|[\s(/-])\p{L}/gu, (wordStart) => wordStart.toUpperCase());
}

function replaceSelectionGroup(selected: string[], group: string[], nextGroup: string[]): string[] {
  const groupSet = new Set(group);
  const nextSet = new Set(nextGroup);
  return [
    ...selected.filter((value) => !groupSet.has(value) || nextSet.has(value)),
    ...nextGroup.filter((value) => !selected.includes(value)),
  ];
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

function isClockHourExtentValue(value: FindingQualifierValue | undefined): value is ClockHourExtentValue {
  return typeof value === "object" && value !== null &&
    Number.isInteger(value.from) && value.from >= 1 && value.from <= 12 &&
    Number.isInteger(value.to) && value.to >= 1 && value.to <= 12 &&
    typeof value.clockwise === "boolean";
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
