import { useState } from "react";
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

interface ClinicalExamCompleteness {
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
  refreshing: boolean;
  onOpenEditor: (sectionId: ChartEditorEntry["id"]) => void;
  onRefresh: () => void;
}

export function ExamOverviewBoard({ projection, editorEntries, refreshing, onOpenEditor, onRefresh }: Props) {
  const [traceOpen, setTraceOpen] = useState(false);
  const findingByReference = new Map(
    projection.findings.map((finding) => [finding.observationReference, finding]),
  );

  return (
    <main className="odos-exam-overview" aria-labelledby="exam-overview-title">
      <header className="odos-exam-overview-heading">
        <div>
          <p>Structure view</p>
          <h1 id="exam-overview-title">Exam overview</h1>
        </div>
        <div className="odos-exam-overview-actions">
          <span>{projection.sections.length} sections</span>
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

      <InterimEditorLauncher entries={editorEntries} onOpenEditor={onOpenEditor} />

      <div className="odos-exam-overview-board">
        {projection.sections.map((section) => {
          const findings = orderedSectionFindings(
            section.findingObservationReferences.flatMap((reference) => {
              const finding = findingByReference.get(reference);
              return finding ? [finding] : [];
            }),
          );
          return (
            <section
              key={section.sectionKey}
              className="odos-exam-section"
              data-testid="exam-overview-section"
              data-section-key={section.sectionKey}
              data-section-state={section.state}
              aria-labelledby={`exam-section-${safeId(section.sectionKey)}`}
            >
              <header className="odos-exam-section-heading">
                <div>
                  <h2 id={`exam-section-${safeId(section.sectionKey)}`}>{section.label}</h2>
                  <span
                    className={`odos-exam-section-state is-${section.state}`}
                    data-channel="section-state"
                    data-state={section.state}
                  >
                    {sectionStateLabel(section.state)}
                  </span>
                </div>
                <div className="odos-exam-section-counts" aria-label={`${section.label} status counts`}>
                  <span className="is-abnormal">{section.abnormalCount} abnormal</span>
                  <span className="is-carried">{section.carriedUnreassertedCount} carried, not reasserted</span>
                  <span className="is-deferred-gap">
                    {`${section.deferredWithoutReasonCount} deferred ${section.deferredWithoutReasonCount === 1 ? "reason" : "reasons"} missing`}
                  </span>
                </div>
              </header>

              {findings.length > 0 ? (
                <div className="odos-exam-finding-list">
                  {findings.map((finding) => (
                    <FindingRow key={finding.observationReference} finding={finding} />
                  ))}
                </div>
              ) : (
                <p className="odos-exam-section-empty">
                  {section.state === "not-indicated"
                    ? "No findings expected for this visit type."
                    : "No finding observations recorded."}
                </p>
              )}
            </section>
          );
        })}
      </div>

      <CompletenessFooter
        completeness={projection.completeness}
        open={traceOpen}
        onToggle={() => setTraceOpen((current) => !current)}
      />
    </main>
  );
}

// Interim scaffolding only: slice 3's docked entry sheets supersede this flat launcher.
// Do not grow it into a persistent rail or add navigation behavior beyond editor reachability.
function InterimEditorLauncher({
  entries,
  onOpenEditor,
}: {
  entries: readonly ChartEditorEntry[];
  onOpenEditor: (sectionId: ChartEditorEntry["id"]) => void;
}) {
  return (
    <section className="odos-exam-editor-launcher" aria-labelledby="chart-section-launcher-title">
      <div className="odos-exam-editor-launcher-heading">
        <h2 id="chart-section-launcher-title">
          Chart section
        </h2>
        <span>Opens the existing section editor</span>
      </div>
      <div className="odos-exam-editor-launcher-list">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-editor-section-id={entry.id}
            onClick={() => onOpenEditor(entry.id)}
            className="odos-exam-editor-launcher-button"
          >
            {entry.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function FindingRow({ finding }: { finding: ExamOverviewFindingProjection }) {
  return (
    <article className="odos-exam-finding" data-finding-key={finding.findingKey}>
      <div className="odos-exam-finding-main">
        <span className={`odos-exam-laterality is-${finding.laterality.toLowerCase()}`} data-testid="finding-laterality">
          {finding.laterality}
        </span>
        <div className="odos-exam-finding-value">
          <strong>{finding.display}</strong>
          <span className="odos-exam-current">{snapshotLabel(finding.current)}</span>
          {finding.prior && (
            <span className="odos-exam-prior" data-testid="finding-prior">
              Prior {snapshotLabel(finding.prior)}
            </span>
          )}
        </div>
      </div>
      <div className="odos-exam-finding-channels">
        <span
          className={`odos-exam-examination is-${finding.examination.state}`}
          data-channel="examination"
          data-state={finding.examination.state}
        >
          {examinationLabel(finding.examination)}
        </span>
        <span
          className={`odos-exam-provenance is-${finding.provenance.state}`}
          data-channel="provenance"
          data-state={finding.provenance.state}
        >
          {provenanceLabel(finding.provenance)}
        </span>
        <span
          className={`odos-exam-interpretation is-${finding.interpretation}`}
          data-channel="interpretation"
          data-state={finding.interpretation}
        >
          {interpretationLabel(finding.interpretation)}
        </span>
        {finding.changeFromPrior && (
          <span className="odos-exam-change" data-channel="change-from-prior">
            {changeLabel(finding.changeFromPrior)}
          </span>
        )}
      </div>
    </article>
  );
}

function CompletenessFooter({
  completeness,
  open,
  onToggle,
}: {
  completeness: ClinicalExamCompleteness;
  open: boolean;
  onToggle: () => void;
}) {
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
        onClick={onToggle}
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
    (value.prior === undefined || isObservationSnapshot(value.prior)) &&
    (value.changeFromPrior === undefined || isChangeFromPrior(value.changeFromPrior));
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

function orderedSectionFindings(
  findings: readonly ExamOverviewFindingProjection[],
): ExamOverviewFindingProjection[] {
  const groups = new Map<string, ExamOverviewFindingProjection[]>();
  for (const finding of findings) {
    const key = `${finding.findingKey}\u0000${finding.display}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.values()].flatMap((group) =>
    group.sort((left, right) => lateralityOrder(left.laterality) - lateralityOrder(right.laterality))
  );
}

function lateralityOrder(laterality: ExamOverviewFindingProjection["laterality"]): number {
  return { OD: 0, OS: 1, OU: 2, UNKNOWN: 3 }[laterality];
}

function snapshotLabel(snapshot: ObservationSnapshot): string {
  const parts = [
    ...(snapshot.value ? [snapshotValueLabel(snapshot.value)] : []),
    ...snapshot.components.map((component) =>
      `${component.display ?? component.code}: ${component.value ? snapshotValueLabel(component.value) : "Not recorded"}`
    ),
  ];
  return parts.join(" · ") || "No recorded value";
}

function snapshotValueLabel(value: ObservationSnapshotValue): string {
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
      return value.display ?? value.text ?? value.code ?? "Code not recorded";
    case "json":
      return Object.entries(value.value).map(([key, nested]) => `${key}: ${String(nested)}`).join(" · ");
  }
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

function examinationLabel(examination: ExamOverviewFindingProjection["examination"]): string {
  if (examination.state === "examined") return "Examined";
  if (examination.state === "deferred-with-reason") {
    return `Deferred — ${examination.reason ?? "reason recorded"}`;
  }
  return "Deferred — reason not recorded";
}

function provenanceLabel(provenance: ExamOverviewFindingProjection["provenance"]): string {
  const date = provenance.sourceDate ? ` from ${provenance.sourceDate}` : "";
  if (provenance.state === "carried-unreasserted") return `Carried — not reasserted${date}`;
  if (provenance.state === "carried-reasserted") return `Carried — reasserted${date}`;
  return "Current visit";
}

function interpretationLabel(interpretation: FindingInterpretation): string {
  return {
    normal: "Normal",
    abnormal: "Abnormal",
    borderline: "Borderline",
    unknown: "Interpretation not recorded",
  }[interpretation];
}

function changeLabel(change: NonNullable<ExamOverviewFindingProjection["changeFromPrior"]>): string {
  if (change.kind === "changed") return "Changed from prior";
  const sign = change.delta > 0 ? "+" : "";
  return `Changed ${sign}${change.delta}${change.unit ? ` ${change.unit}` : ""}`;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}
