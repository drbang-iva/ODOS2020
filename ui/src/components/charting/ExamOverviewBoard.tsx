import { useState } from "react";
import { isExamEntrySheetSectionId } from "./ExamEntrySheet";
import type { ChartEditorEntry } from "./SpineNav";

type ExamObservationState =
  | "examined"
  | "deferred-with-reason"
  | "deferred-without-reason";

type ExamSectionState = ExamObservationState | "not-examined" | "not-indicated";
type ExamFindingProvenanceState = "current" | "carried-unreasserted" | "carried-reasserted";
type FindingInterpretation = "normal" | "abnormal" | "borderline" | "unknown";

type ObservationSnapshotValue =
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "quantity"; value: number; unit?: string; system?: string; code?: string }
  | { kind: "code"; code?: string; display?: string; text?: string }
  | { kind: "json"; value: Record<string, unknown> };

interface ObservationSnapshot {
  recordedAt?: string;
  value?: ObservationSnapshotValue;
  components: Array<{
    code: string;
    display?: string;
    value?: ObservationSnapshotValue;
  }>;
}

interface ExamOverviewFindingProjection {
  observationReference: string;
  findingKey: string;
  sectionKey: string;
  display: string;
  laterality: "OD" | "OS" | "OU" | "UNKNOWN";
  examination: {
    state: ExamObservationState;
    reason?: string;
    sourceEncoding: "observation" | "exam-state" | "dilation-declined" | "not-visualized-json";
  };
  interpretation: FindingInterpretation;
  provenance: { state: ExamFindingProvenanceState; sourceDate?: string };
  current: ObservationSnapshot;
  summary?: string;
  event?: {
    administrations: Array<{
      agent: string;
      occurredAt: string;
    }>;
  };
  diagnoses?: Array<{
    display: string;
    laterality?: "OD" | "OS" | "OU";
  }>;
  attestation?: {
    attestedBy: string[];
    recordedAt?: string;
  };
  prior?: ObservationSnapshot;
  changeFromPrior?: { kind: "numeric"; delta: number; unit?: string } | { kind: "changed" };
}

interface ExamOverviewSectionProjection {
  sectionKey: string;
  label: string;
  state: ExamSectionState;
  findingObservationReferences: string[];
  abnormalCount: number;
  carriedUnreassertedCount: number;
  deferredWithoutReasonCount: number;
}

export interface ClinicalExamCompleteness {
  status: "complete" | "incomplete" | "unconfigured";
  requiredSectionCount: number;
  resolvedSectionCount: number;
  trace: Array<{
    sectionKey: string;
    label: string;
    state: ExamSectionState;
    resolved: boolean;
    carriedUnreassertedCount: number;
  }>;
  documentationIssues: Array<{
    sectionKey: string;
    issue: "deferred-reason-missing";
  }>;
}

export interface ExamOverviewProjection {
  encounterReference: string;
  patientReference: string;
  visitTypeCategoryId?: string;
  findings: ExamOverviewFindingProjection[];
  sections: ExamOverviewSectionProjection[];
  completeness: ClinicalExamCompleteness;
}

interface Props {
  projection: ExamOverviewProjection;
  editorEntries: readonly ChartEditorEntry[];
  activeEditorId?: ChartEditorEntry["id"];
  refreshing: boolean;
  onOpenEditor: (sectionId: ChartEditorEntry["id"]) => void;
  onRefresh: () => void;
}

export function ExamOverviewBoard({ projection, editorEntries, activeEditorId, refreshing, onOpenEditor, onRefresh }: Props) {
  const findingByReference = new Map(
    projection.findings.map((finding) => [finding.observationReference, finding]),
  );
  const editorGroups = groupEditorEntries(editorEntries);
  const wearingFindings = projection.findings.filter((finding) => finding.findingKey === "wearing_rx");
  const boardSections: Array<{
    sectionKey: string;
    label: string;
    groups: FindingGroup[];
  }> = projection.sections.flatMap((section) => {
    const findings = (section.findingObservationReferences ?? []).flatMap((reference) => {
      const finding = findingByReference.get(reference);
      return finding && finding.provenance.state === "current" && finding.findingKey !== "wearing_rx"
        ? [finding]
        : [];
    });
    const groups = groupFindings(findings);
    return groups.length ? [{
      sectionKey: section.sectionKey,
      label: section.label,
      groups,
    }] : [];
  });
  const performedEditorIds = new Set(boardSections.flatMap((section) =>
    section.groups.flatMap((group) => {
      const editor = editorForFinding(group, editorEntries);
      return editor ? [editor.id] : [];
    })
  ));
  const chartAnotherGroups = Array.from(editorGroups.entries()).flatMap(([sectionKey, entries]) => {
    const remaining = entries.filter((entry) => !performedEditorIds.has(entry.id));
    return remaining.length ? [[sectionKey, remaining] as const] : [];
  });

  return (
    <main className="odos-exam-overview" aria-labelledby="exam-overview-title">
      <header className="odos-exam-overview-heading">
        <div>
          <p>Structure view</p>
          <h1 id="exam-overview-title">Exam overview</h1>
        </div>
        <div className="odos-exam-overview-actions">
          <span>{boardSections.length} sections</span>
          <button
            type="button"
            data-testid="refresh-exam-overview"
            disabled={refreshing}
            onClick={onRefresh}
            className="odos-exam-overview-refresh"
          >
            {refreshing ? "Refreshing exam overview…" : "Refresh exam overview"}
          </button>
        </div>
      </header>

      <div className="odos-exam-overview-board">
        {boardSections.map((section) => (
            <section
              key={section.sectionKey}
              className="odos-exam-section"
              data-testid="exam-overview-section"
              data-section-key={section.sectionKey}
              aria-labelledby={`exam-section-${safeId(section.sectionKey)}`}
            >
              <header className="odos-exam-section-heading">
                <h2 id={`exam-section-${safeId(section.sectionKey)}`}>{section.label}</h2>
              </header>
              <div className="odos-exam-finding-list">
                {section.groups.map((group) => (
                  <FindingRow
                    key={`${group.findingKey}\u0000${group.display}`}
                    group={group}
                    wearingFindings={wearingFindings}
                    editor={editorForFinding(group, editorEntries)}
                    onOpenEditor={onOpenEditor}
                  />
                ))}
              </div>
            </section>
        ))}
      </div>

      {chartAnotherGroups.length > 0 && (
        <nav className="odos-exam-chart-another" aria-label="Chart another finding">
          {chartAnotherGroups.map(([sectionKey, entries]) => (
            <ChartAnotherFinding
              key={sectionKey}
              label={editorGroupLabel(entries[0]?.group, sectionKey)}
              entries={entries}
              activeEditorId={activeEditorId}
              onOpenEditor={onOpenEditor}
            />
          ))}
        </nav>
      )}

    </main>
  );
}

function ChartAnotherFinding({
  label,
  entries,
  activeEditorId,
  onOpenEditor,
}: {
  label: string;
  entries: readonly ChartEditorEntry[];
  activeEditorId?: ChartEditorEntry["id"];
  onOpenEditor: (sectionId: ChartEditorEntry["id"]) => void;
}) {
  return (
    <details className="odos-exam-editor-entries" data-testid="chart-another-finding">
      <summary>Chart another finding <span>{label}</span></summary>
      <div className="odos-exam-editor-entry-list">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-testid="exam-editor-entry-row"
            data-editor-section-id={entry.id}
            data-editor-presentation={isExamEntrySheetSectionId(entry.id) ? "sheet" : "full-page"}
            aria-pressed={activeEditorId === entry.id}
            onClick={() => onOpenEditor(entry.id)}
            className={`odos-exam-editor-entry${activeEditorId === entry.id ? " is-active" : ""}`}
          >
            <span className="odos-exam-editor-entry-label">{entry.label}</span>
            <span className="odos-exam-editor-entry-presentation">
              <span aria-hidden>{isExamEntrySheetSectionId(entry.id) ? "▣" : "↗"}</span>
              {isExamEntrySheetSectionId(entry.id) ? "Entry sheet" : "Expand"}
            </span>
          </button>
        ))}
      </div>
    </details>
  );
}

function groupEditorEntries(entries: readonly ChartEditorEntry[]): Map<string, ChartEditorEntry[]> {
  const groups = new Map<string, ChartEditorEntry[]>();
  for (const entry of entries) {
    const sectionKey = editorGroupKey(entry.group);
    const group = groups.get(sectionKey);
    if (group) group.push(entry);
    else groups.set(sectionKey, [entry]);
  }
  return groups;
}

function editorGroupKey(group?: string): string {
  if (group === "ASSESSMENT & PLAN") return "assessment";
  if (!group) return "other";
  return group.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
}

function editorGroupLabel(group: string | undefined, sectionKey: string): string {
  if (group) return group.toLocaleLowerCase().replaceAll(/\b\w/g, (letter) => letter.toLocaleUpperCase());
  return sectionKey.replaceAll("-", " ").replaceAll(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

type RowPattern = "word" | "eye-pair" | "event" | "diagram" | "rx";

interface FindingGroup {
  findingKey: string;
  display: string;
  rows: ExamOverviewFindingProjection[];
}

function FindingRow({
  group,
  wearingFindings,
  editor,
  onOpenEditor,
}: {
  group: FindingGroup;
  wearingFindings: ExamOverviewFindingProjection[];
  editor?: ChartEditorEntry;
  onOpenEditor: (sectionId: ChartEditorEntry["id"]) => void;
}) {
  const pattern = findingPattern(group);
  const exception = group.rows.some((row) =>
    row.interpretation === "abnormal" || row.interpretation === "borderline" || row.examination.state !== "examined"
  );
  const openEditor = editor ? () => onOpenEditor(editor.id) : undefined;
  return (
    <article
      className={`odos-exam-finding${exception ? " is-exception" : ""}${openEditor ? " is-clickable" : ""}`}
      data-testid="exam-finding-row"
      data-finding-key={group.findingKey}
      data-row-pattern={pattern}
      onClick={openEditor}
    >
      <span className="odos-exam-finding-name">{group.display}{pattern === "rx" ? " — Manifest" : ""}</span>
      <div className="odos-exam-finding-value">
        {pattern === "word" && <WordResult group={group} />}
        {pattern === "eye-pair" && <EyePairResult group={group} />}
        {pattern === "event" && <EventResult group={group} />}
        {pattern === "diagram" && <DiagramResult group={group} />}
        {pattern === "rx" && <RxResult group={group} wearingFindings={wearingFindings} />}
      </div>
      {openEditor && (
        <button
          type="button"
          className="odos-exam-finding-editor"
          data-testid="exam-finding-editor"
          aria-label={`Edit ${group.display}`}
          onClick={(event) => {
            event.stopPropagation();
            openEditor();
          }}
        >
          Edit
        </button>
      )}
      {exception && <FindingExpansion group={group} />}
    </article>
  );
}

function WordResult({ group }: { group: FindingGroup }) {
  return <span>{wordValue(group.rows[0]!)}</span>;
}

function EyePairResult({ group }: { group: FindingGroup }) {
  const rows = [...group.rows].sort((left, right) => lateralityOrder(left.laterality) - lateralityOrder(right.laterality));
  const values = rows.map((row) => ({ row, value: findingValue(row) }));
  const equalNormal = values.length > 1 && values.every(({ row, value }) =>
    row.interpretation === "normal" && value === values[0]?.value
  );
  if (equalNormal) return <span>{values[0]?.value}</span>;
  return (
    <span className="odos-exam-eye-pair">
      {values.map(({ row, value }) => (
        <span key={row.laterality} className="odos-exam-eye-value">
          <small>{row.laterality}</small> {value}
        </span>
      ))}
    </span>
  );
}

function EventResult({ group }: { group: FindingGroup }) {
  const administrations = group.rows.flatMap((row) => row.event?.administrations ?? []);
  const instants = [...new Set(administrations.map((administration) => administration.occurredAt))];
  if (instants.length === 1) {
    return <span>{administrations.map((administration) => administration.agent).join(" + ")} · {timeLabel(instants[0]!)}</span>;
  }
  return <span>{administrations.map((administration) => `${administration.agent} · ${timeLabel(administration.occurredAt)}`).join(" + ")}</span>;
}

function DiagramResult({ group }: { group: FindingGroup }) {
  if (group.rows.every((row) => row.interpretation === "normal")) return <span>full</span>;
  const byEye = new Map(group.rows.map((row) => [row.laterality, row]));
  return (
    <span className="odos-exam-field-pair">
      {(["OD", "OS"] as const).map((eye) => (
        <VisualFieldDiagram key={eye} eye={eye} finding={byEye.get(eye)} />
      ))}
    </span>
  );
}

const CVF_QUADRANTS = [
  ["upper-left", "CUSTOM_CVF_UPPER_LEFT"],
  ["upper-right", "CUSTOM_CVF_UPPER_RIGHT"],
  ["lower-left", "CUSTOM_CVF_LOWER_LEFT"],
  ["lower-right", "CUSTOM_CVF_LOWER_RIGHT"],
] as const;

function VisualFieldDiagram({ eye, finding }: { eye: "OD" | "OS"; finding?: ExamOverviewFindingProjection }) {
  const restricted = CVF_QUADRANTS.flatMap(([quadrant, code]) =>
    snapshotComponentText(finding?.current, code)?.toLowerCase() === "restricted" ? [quadrant] : []
  );
  return (
    <span className="odos-exam-field-eye">
      <small>{eye}</small>
      <span
        className="odos-exam-field-diagram"
        data-testid="visual-field-diagram"
        data-eye={eye}
        data-restricted-quadrants={restricted.join(",")}
        aria-label={`${eye} confrontation field: ${restricted.length ? `${restricted.join(", ")} restricted` : "clear"}`}
      >
        {CVF_QUADRANTS.map(([quadrant]) => (
          <span key={quadrant} className={`is-${quadrant}${restricted.includes(quadrant) ? " is-restricted" : ""}`} />
        ))}
      </span>
    </span>
  );
}

function RxResult({ group, wearingFindings }: { group: FindingGroup; wearingFindings: ExamOverviewFindingProjection[] }) {
  const blocks = refractionBlocks(group.rows);
  const manifest = blocks
    .filter((block) => block.type === "MANIFEST")
    .sort((left, right) => instantMillis(right.recordedAt) - instantMillis(left.recordedAt))[0];
  if (!manifest) return <span>Manifest not recorded</span>;
  const add = manifest.eyes.OD?.add ?? manifest.eyes.OS?.add;
  const wearing = wearingRx(wearingFindings);
  const comparison = wearing ?? manifest.priorEyes;
  const comparisonLabel = wearing ? "Wearing Rx" : Object.keys(manifest.priorEyes).length ? "Prior refraction" : undefined;
  return (
    <span className="odos-exam-rx-result">
      <span className="odos-exam-rx-primary">
        {rxEyeLine("OD", manifest.eyes.OD)} {rxEyeLine("OS", manifest.eyes.OS)}
        {add !== undefined ? ` Add ${signedPower(add)}` : ""}
      </span>
      {comparisonLabel && (
        <span className="odos-exam-rx-comparison">
          <small>{comparisonLabel}</small> {rxEyeLine("OD", comparison.OD, false)} {rxEyeLine("OS", comparison.OS, false)}
        </span>
      )}
      <details className="odos-exam-rx-battery" onClick={(event) => event.stopPropagation()}>
        <summary>Full battery · {blocks.length} {blocks.length === 1 ? "block" : "blocks"} ▸</summary>
      </details>
    </span>
  );
}

function FindingExpansion({ group }: { group: FindingGroup }) {
  const diagnoses = uniqueRows(group.rows.flatMap((row) => row.diagnoses ?? []), (row) => `${row.display}\u0000${row.laterality ?? ""}`);
  const attesters = [...new Set(group.rows.flatMap((row) => row.attestation?.attestedBy ?? []))];
  const recordedAt = group.rows.map((row) => row.attestation?.recordedAt).find(Boolean);
  return (
    <details className="odos-exam-finding-expansion" onClick={(event) => event.stopPropagation()}>
      <summary>Details</summary>
      {diagnoses.map((diagnosis) => (
        <span key={`${diagnosis.display}-${diagnosis.laterality ?? ""}`} className="odos-exam-filed-under">
          filed under: {diagnosis.display}{diagnosis.laterality ? ` — ${diagnosis.laterality}` : ""}
        </span>
      ))}
      {attesters.length > 0 && (
        <span className="odos-exam-attestation">
          Attested by {attesters.join(", ")}
          {recordedAt ? ` · ${timeLabel(recordedAt)}` : ""} · current visit
        </span>
      )}
    </details>
  );
}

export function ExamCompletenessControl({ completeness }: { completeness?: ClinicalExamCompleteness }) {
  const [open, setOpen] = useState(false);
  if (!completeness) {
    return (
      <div className="odos-exam-completeness is-loading" role="status">
        <strong>Exam sections: Loading</strong>
      </div>
    );
  }
  if (completeness.status === "unconfigured") {
    return (
      <footer
        className="odos-exam-completeness is-unconfigured"
        data-completeness-status="unconfigured"
        role="status"
      >
        <strong>Exam sections: Not configured</strong>
        <span>Section requirements are not configured for this visit type.</span>
      </footer>
    );
  }
  return (
    <footer
      className={`odos-exam-completeness is-${completeness.status}`}
      data-completeness-status={completeness.status}
    >
      <button
        type="button"
        className="odos-exam-completeness-trigger"
        data-testid="exam-completeness-trigger"
        aria-controls="exam-completeness-trace"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        Exam sections: {completeness.resolvedSectionCount} of {completeness.requiredSectionCount}
      </button>
      {open && (
        <div id="exam-completeness-trace" className="odos-exam-completeness-trace">
          <p>This count is relative to the visit type and is not a billing-code check.</p>
          <ul>
            {completeness.trace.map((row) => (
              <li key={row.sectionKey}>
                <strong>{row.label}</strong>
                <span>{sectionStateLabel(row.state)}</span>
                <span>{row.resolved ? "Resolved" : "Unresolved"}</span>
                {row.carriedUnreassertedCount > 0 && (
                  <span>{row.carriedUnreassertedCount} carried, not reasserted</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </footer>
  );
}

export function isExamOverviewProjection(value: unknown): value is ExamOverviewProjection {
  if (!isRecord(value)) return false;
  return typeof value.encounterReference === "string" &&
    typeof value.patientReference === "string" &&
    optionalString(value.visitTypeCategoryId) &&
    Array.isArray(value.findings) && value.findings.every(isFindingProjection) &&
    Array.isArray(value.sections) && value.sections.every(isSectionProjection) &&
    isCompleteness(value.completeness);
}

function isFindingProjection(value: unknown): value is ExamOverviewFindingProjection {
  if (!isRecord(value) || !isRecord(value.examination) || !isRecord(value.provenance)) return false;
  return typeof value.observationReference === "string" &&
    typeof value.findingKey === "string" &&
    typeof value.sectionKey === "string" &&
    typeof value.display === "string" &&
    oneOf(value.laterality, ["OD", "OS", "OU", "UNKNOWN"]) &&
    oneOf(value.examination.state, ["examined", "deferred-with-reason", "deferred-without-reason"]) &&
    optionalString(value.examination.reason) &&
    oneOf(value.examination.sourceEncoding, ["observation", "exam-state", "dilation-declined", "not-visualized-json"]) &&
    oneOf(value.interpretation, ["normal", "abnormal", "borderline", "unknown"]) &&
    oneOf(value.provenance.state, ["current", "carried-unreasserted", "carried-reasserted"]) &&
    optionalString(value.provenance.sourceDate) &&
    isObservationSnapshot(value.current) &&
    optionalString(value.summary) &&
    (value.event === undefined || isFindingEvent(value.event)) &&
    (value.diagnoses === undefined || isFindingDiagnoses(value.diagnoses)) &&
    (value.attestation === undefined || isFindingAttestation(value.attestation)) &&
    (value.prior === undefined || isObservationSnapshot(value.prior)) &&
    (value.changeFromPrior === undefined || isChangeFromPrior(value.changeFromPrior));
}

function isFindingEvent(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.administrations) && value.administrations.every((administration) =>
    isRecord(administration) && typeof administration.agent === "string" && typeof administration.occurredAt === "string"
  );
}

function isFindingDiagnoses(value: unknown): boolean {
  return Array.isArray(value) && value.every((diagnosis) =>
    isRecord(diagnosis) && typeof diagnosis.display === "string" &&
    (diagnosis.laterality === undefined || oneOf(diagnosis.laterality, ["OD", "OS", "OU"]))
  );
}

function isFindingAttestation(value: unknown): boolean {
  return isRecord(value) && stringArray(value.attestedBy) && optionalString(value.recordedAt);
}

function isSectionProjection(value: unknown): value is ExamOverviewSectionProjection {
  return isRecord(value) &&
    typeof value.sectionKey === "string" &&
    typeof value.label === "string" &&
    oneOf(value.state, ["examined", "deferred-with-reason", "deferred-without-reason", "not-examined", "not-indicated"]) &&
    stringArray(value.findingObservationReferences) &&
    finiteNumber(value.abnormalCount) &&
    finiteNumber(value.carriedUnreassertedCount) &&
    finiteNumber(value.deferredWithoutReasonCount);
}

function isCompleteness(value: unknown): value is ClinicalExamCompleteness {
  return isRecord(value) &&
    oneOf(value.status, ["complete", "incomplete", "unconfigured"]) &&
    finiteNumber(value.requiredSectionCount) &&
    finiteNumber(value.resolvedSectionCount) &&
    Array.isArray(value.trace) && value.trace.every((row) =>
      isRecord(row) &&
      typeof row.sectionKey === "string" &&
      typeof row.label === "string" &&
      oneOf(row.state, ["examined", "deferred-with-reason", "deferred-without-reason", "not-examined", "not-indicated"]) &&
      typeof row.resolved === "boolean" &&
      finiteNumber(row.carriedUnreassertedCount)
    ) &&
    Array.isArray(value.documentationIssues) && value.documentationIssues.every((issue) =>
      isRecord(issue) &&
      typeof issue.sectionKey === "string" &&
      issue.issue === "deferred-reason-missing"
    );
}

function isObservationSnapshot(value: unknown): value is ObservationSnapshot {
  return isRecord(value) &&
    optionalString(value.recordedAt) &&
    (value.value === undefined || isSnapshotValue(value.value)) &&
    Array.isArray(value.components) && value.components.every((component) =>
      isRecord(component) &&
      typeof component.code === "string" &&
      optionalString(component.display) &&
      (component.value === undefined || isSnapshotValue(component.value))
    );
}

function isSnapshotValue(value: unknown): value is ObservationSnapshotValue {
  if (!isRecord(value)) return false;
  if (value.kind === "boolean") return typeof value.value === "boolean";
  if (value.kind === "number") return finiteNumber(value.value);
  if (value.kind === "string") return typeof value.value === "string";
  if (value.kind === "quantity") {
    return finiteNumber(value.value) && optionalString(value.unit) && optionalString(value.system) && optionalString(value.code);
  }
  if (value.kind === "code") {
    return optionalString(value.code) && optionalString(value.display) && optionalString(value.text);
  }
  return value.kind === "json" && isRecord(value.value);
}

function isChangeFromPrior(value: unknown): value is NonNullable<ExamOverviewFindingProjection["changeFromPrior"]> {
  return isRecord(value) && (value.kind === "changed" || (
    value.kind === "numeric" && finiteNumber(value.delta) && optionalString(value.unit)
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function oneOf<const T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}

function groupFindings(findings: readonly ExamOverviewFindingProjection[]): FindingGroup[] {
  const groups = new Map<string, ExamOverviewFindingProjection[]>();
  for (const finding of findings) {
    const key = `${finding.findingKey}\u0000${finding.display}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.values()].map((rows) => ({
    findingKey: rows[0]!.findingKey,
    display: rows[0]!.display,
    rows: rows.sort((left, right) => lateralityOrder(left.laterality) - lateralityOrder(right.laterality)),
  }));
}

function lateralityOrder(laterality: ExamOverviewFindingProjection["laterality"]): number {
  return { OD: 0, OS: 1, OU: 2, UNKNOWN: 3 }[laterality];
}

function editorForFinding(
  group: FindingGroup,
  editorEntries: readonly ChartEditorEntry[],
): ChartEditorEntry | undefined {
  const knownEditor = {
    "entrance:cover": "cover-test",
    "entrance:color": "color-vision",
    "entrance:stereo": "stereopsis",
    intraocular_pressure: "iop",
    cup_disc_ratio: "cup-disc",
    manual_keratometry: "manual-keratometry",
    auto_refraction: "auto-refraction",
    hpi_ros: "hpi",
  }[group.findingKey];
  const candidates = [
    knownEditor,
    group.findingKey,
    group.findingKey.split(":").at(-1),
    group.rows[0]?.sectionKey,
    group.rows[0]?.sectionKey.split(":").at(-1),
    group.findingKey === "pachymetry_um" ? "pachymetry" : undefined,
    group.findingKey === "entrance:cvf" ? "cvf" : undefined,
    group.findingKey === "entrance:eom" ? "eom" : undefined,
  ].filter(Boolean);
  return editorEntries.find((entry) => candidates.includes(entry.id));
}

function findingPattern(group: FindingGroup): RowPattern {
  if (group.rows.every((row) => row.examination.state !== "examined")) return "word";
  if (group.rows.some((row) => (row.event?.administrations.length ?? 0) > 0)) return "event";
  if (group.findingKey === "refraction" || group.rows.some((row) =>
    ["SPHERE", "CYLINDER", "AXIS", "ADD"].some((code) => snapshotComponent(row.current, code))
  )) return "rx";
  if (group.findingKey === "entrance:cvf" || group.rows.some((row) =>
    CVF_QUADRANTS.some(([, code]) => snapshotComponent(row.current, code))
  )) return "diagram";
  if (group.rows.some((row) => row.laterality === "OD" || row.laterality === "OS")) return "eye-pair";
  return "word";
}

function wordValue(finding: ExamOverviewFindingProjection): string {
  if (finding.examination.state !== "examined") {
    return `deferred — ${finding.examination.reason ?? "reason not recorded"}`;
  }
  return finding.summary ?? findingValue(finding);
}

function findingValue(finding: ExamOverviewFindingProjection): string {
  const normalWord = finding.interpretation === "normal" ? normalFindingWord(finding.findingKey) : undefined;
  if (normalWord) return normalWord;
  if (finding.summary) return finding.summary;
  const manualKeratometry = manualKeratometryValue(finding);
  if (manualKeratometry) return manualKeratometry;
  if (finding.current.value) {
    const label = safeSnapshotValueLabel(finding.current.value);
    if (label) return label;
  }
  const preferredCode = {
    pachymetry_um: "CUSTOM_CCT",
  }[finding.findingKey];
  if (preferredCode) {
    const label = snapshotComponentLabel(finding.current, preferredCode);
    if (label) return label;
  }
  if (finding.interpretation === "abnormal") return "abnormal";
  if (finding.interpretation === "borderline") return "borderline";
  return "recorded";
}

function manualKeratometryValue(finding: ExamOverviewFindingProjection): string | undefined {
  if (finding.findingKey !== "manual_keratometry") return undefined;
  const prefix = finding.laterality === "OD" || finding.laterality === "OS" ? `${finding.laterality}_` : "";
  const value = (code: string) => snapshotNumber(finding.current, `${prefix}${code}`) ?? snapshotNumber(finding.current, code);
  const flatK = value("CUSTOM_FLAT_K");
  const flatAxis = value("CUSTOM_FLAT_AXIS");
  const steepK = value("CUSTOM_STEEP_K");
  const steepAxis = value("CUSTOM_STEEP_AXIS");
  if (flatK === undefined || flatAxis === undefined || steepK === undefined || steepAxis === undefined) return undefined;
  return `${flatK.toFixed(2)} @${String(flatAxis).padStart(3, "0")} / ${steepK.toFixed(2)} @${String(steepAxis).padStart(3, "0")}`;
}

function normalFindingWord(findingKey: string): string | undefined {
  return {
    "entrance:eom": "full",
    "entrance:cvf": "full",
    "confrontation-visual-fields": "full",
    "entrance:color": "normal",
  }[findingKey];
}

function safeSnapshotValueLabel(value: ObservationSnapshotValue): string | undefined {
  switch (value.kind) {
    case "boolean":
      return value.value ? "Yes" : "No";
    case "number":
      return String(value.value);
    case "string":
      return value.value;
    case "quantity":
      return `${value.value}${value.unit ? ` ${value.unit}` : ""}`;
    case "code":
      return value.display ?? value.text;
    case "json":
      return undefined;
  }
}

function snapshotComponent(snapshot: ObservationSnapshot | undefined, code: string) {
  return snapshot?.components.find((component) => component.code === code);
}

function snapshotComponentText(snapshot: ObservationSnapshot | undefined, code: string): string | undefined {
  const value = snapshotComponent(snapshot, code)?.value;
  if (!value) return undefined;
  if (value.kind === "string") return value.value;
  if (value.kind === "code") return value.display ?? value.text ?? value.code;
  return safeSnapshotValueLabel(value);
}

function snapshotComponentLabel(snapshot: ObservationSnapshot | undefined, code: string): string | undefined {
  const value = snapshotComponent(snapshot, code)?.value;
  return value ? safeSnapshotValueLabel(value) : undefined;
}

function snapshotNumber(snapshot: ObservationSnapshot | undefined, code: string): number | undefined {
  const value = snapshotComponent(snapshot, code)?.value;
  return value?.kind === "quantity" || value?.kind === "number" ? value.value : undefined;
}

interface RxEyeValues {
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  distanceVisualAcuity?: string;
}

interface RefractionBlock {
  id: string;
  type: string;
  recordedAt: string;
  eyes: Partial<Record<"OD" | "OS", RxEyeValues>>;
  priorEyes: Partial<Record<"OD" | "OS", RxEyeValues>>;
}

function refractionBlocks(findings: readonly ExamOverviewFindingProjection[]): RefractionBlock[] {
  const blocks = new Map<string, RefractionBlock>();
  findings.forEach((finding, index) => {
    const blockId = snapshotComponentText(finding.current, "REFRACTION_BLOCK_ID") ?? `ungrouped-${index}`;
    const typeValue = snapshotComponent(finding.current, "REFRACTION_TYPE")?.value;
    const type = typeValue?.kind === "code"
      ? typeValue.code ?? typeValue.display ?? typeValue.text ?? ""
      : snapshotComponentText(finding.current, "REFRACTION_TYPE") ?? "";
    const block = blocks.get(blockId) ?? {
      id: blockId,
      type,
      recordedAt: finding.current.recordedAt ?? "",
      eyes: {},
      priorEyes: {},
    };
    if (finding.laterality === "OD" || finding.laterality === "OS") {
      block.eyes[finding.laterality] = rxEyeFromSnapshot(finding.current);
      if (finding.prior) block.priorEyes[finding.laterality] = rxEyeFromSnapshot(finding.prior);
    }
    if (instantMillis(finding.current.recordedAt) > instantMillis(block.recordedAt)) {
      block.recordedAt = finding.current.recordedAt ?? "";
    }
    blocks.set(blockId, block);
  });
  return [...blocks.values()];
}

function rxEyeFromSnapshot(snapshot: ObservationSnapshot): RxEyeValues {
  return {
    ...quantityField(snapshot, "SPHERE", "sphere"),
    ...quantityField(snapshot, "CYLINDER", "cylinder"),
    ...quantityField(snapshot, "AXIS", "axis"),
    ...quantityField(snapshot, "ADD", "add"),
    ...(snapshotComponentText(snapshot, "DISTANCE_VA") ? { distanceVisualAcuity: snapshotComponentText(snapshot, "DISTANCE_VA") } : {}),
  };
}

function quantityField(snapshot: ObservationSnapshot, code: string, key: keyof RxEyeValues) {
  const value = snapshotComponent(snapshot, code)?.value;
  return value?.kind === "quantity" || value?.kind === "number" ? { [key]: value.value } : {};
}

function wearingRx(findings: readonly ExamOverviewFindingProjection[]): Partial<Record<"OD" | "OS", RxEyeValues>> | undefined {
  const latest = [...findings].sort((left, right) =>
    instantMillis(right.current.recordedAt) - instantMillis(left.current.recordedAt)
  )[0];
  if (!latest) return undefined;
  const eyes = Object.fromEntries((["OD", "OS"] as const).flatMap((eye) => {
    const values: RxEyeValues = {
      ...quantityField(latest.current, `${eye}_SPHERE`, "sphere"),
      ...quantityField(latest.current, `${eye}_CYLINDER`, "cylinder"),
      ...quantityField(latest.current, `${eye}_AXIS`, "axis"),
      ...quantityField(latest.current, `${eye}_ADD`, "add"),
    };
    return Object.keys(values).length ? [[eye, values]] : [];
  })) as Partial<Record<"OD" | "OS", RxEyeValues>>;
  return Object.keys(eyes).length ? eyes : undefined;
}

function instantMillis(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function rxEyeLine(eye: "OD" | "OS", values: RxEyeValues | undefined, showAcuity = true): string {
  if (!values || values.sphere === undefined) return `${eye} —`;
  const cylinder = values.cylinder === undefined
    ? "sph"
    : `${signedPower(values.cylinder)}${values.axis === undefined ? "" : ` ×${String(values.axis).padStart(3, "0")}`}`;
  return `${eye} ${signedPower(values.sphere)} ${cylinder}${showAcuity && values.distanceVisualAcuity ? ` ${values.distanceVisualAcuity}` : ""}`;
}

function signedPower(value: number): string {
  if (value < 0) return `−${Math.abs(value).toFixed(2)}`;
  return `+${value.toFixed(2)}`;
}

function timeLabel(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(instant);
}

function uniqueRows<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const value = key(row);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function sectionStateLabel(state: ExamSectionState): string {
  return {
    examined: "Examined",
    "deferred-with-reason": "Deferred — reason recorded",
    "deferred-without-reason": "Deferred — reason not recorded",
    "not-examined": "Not examined",
    "not-indicated": "Not indicated",
  }[state];
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}
