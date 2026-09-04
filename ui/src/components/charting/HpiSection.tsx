import { useEffect, useRef, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { removeValueConfirmSpec, voidEncounterEntries } from "../../lib/encounter-void";
import { ClearSectionButton } from "./ClearControls";
import { useConfirmDestructive } from "./ConfirmDestructive";
import { useEncounterEdit } from "./encounter-edit-context";
import type { SectionSaveStatus } from "./types";

export type HistorySectionType =
  | "presentation" | "symptoms" | "quality" | "severity" | "duration" | "risk_factors"
  | "treatment" | "numeric" | "presents_for" | "interval" | "laterality" | "text";
export type HistoryTriState = "positive" | "negative";
export type HistoryAnswerValue =
  | { kind: "tri-state"; status: HistoryTriState; note?: string }
  | { kind: "selection"; code: string }
  | { kind: "severity"; level: "mild" | "moderate" | "severe" }
  | { kind: "duration"; value: number; unit: "days" | "weeks" | "months" | "years" }
  | { kind: "numeric"; value: number; unit?: string }
  | { kind: "interval"; code: "better" | "same" | "worse"; note?: string }
  | { kind: "laterality"; code: "OD-worse" | "OS-worse" | "equal" | "other"; note?: string }
  | { kind: "text"; text: string };

interface HistoryTemplateAnswerBase {
  id: string;
  templateKey: string;
  sectionId: string;
  optionCode?: string;
  eye?: "OD" | "OS" | "OU";
  observationReference?: string;
  value: HistoryAnswerValue;
}

export type HistoryTemplateAnswer = HistoryTemplateAnswerBase & (
  | { complaintId: string; subjectScope?: never }
  | { complaintId?: never; subjectScope: "encounter" | "patient" }
);

export interface HistoryTemplateSection {
  id: string;
  type: HistorySectionType;
  label: string;
  catalog?: string;
  when?: "past" | "current";
  per_eye?: boolean;
  on?: "follow-up";
  prefill?: "last_plan";
  required?: boolean;
}

export interface HistoryTemplate {
  complaint: string;
  label: string;
  presentations: string;
  sections: HistoryTemplateSection[];
  narrative: string;
}

export interface HistorySubjectSection {
  key: string;
  label: string;
  subjectScope: "encounter" | "patient";
  completionAnchor: string;
  sections: HistoryTemplateSection[];
}

export type HistoryCatalogs = Record<string, Array<{
  code: string;
  display: string;
  per_eye?: boolean;
  note_on_positive?: boolean;
}>>;

interface CarriedForwardHistoryAnswer {
  answer: HistoryTemplateAnswer;
  encounterReference: string;
  recordedAt: string;
}

interface HistoryReviewAttestation {
  sectionKey: string;
  actorReference: string;
  recordedAt: string;
  attestationReference: string;
  priorAnswerReferences: string[];
}

interface EncounterComplaint {
  id: string;
  ordinal: number;
  templateKey?: string;
  complaintKey?: string;
  freeTextLabel?: string;
  renderedNarrative: string;
}

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus, keepOpen: boolean) => void;
}

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; at: number }
  | { status: "error"; reason: string };

export function HpiSection({ patientReference, encounterReference, onSaved }: Props) {
  const encounterId = encounterReference.slice("Encounter/".length);
  const [templates, setTemplates] = useState<HistoryTemplate[]>([]);
  const [subjectSections, setSubjectSections] = useState<HistorySubjectSection[]>([]);
  const [catalogs, setCatalogs] = useState<HistoryCatalogs>({});
  const [complaints, setComplaints] = useState<EncounterComplaint[]>([]);
  const [answers, setAnswers] = useState<HistoryTemplateAnswer[]>([]);
  const [followUpPrefills, setFollowUpPrefills] = useState<HistoryTemplateAnswer[]>([]);
  const [carriedForwardAnswers, setCarriedForwardAnswers] = useState<CarriedForwardHistoryAnswer[]>([]);
  const [reviewAttestations, setReviewAttestations] = useState<HistoryReviewAttestation[]>([]);
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [narratives, setNarratives] = useState<Record<string, string>>({});
  const [folded, setFolded] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [clock, setClock] = useState(Date.now());
  const [adding, setAdding] = useState(false);
  const debounceTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const latestAnswers = useRef<HistoryTemplateAnswer[]>([]);
  const persistedAnswerReferences = useRef(new Map<string, string>());
  const saveQueue = useRef(Promise.resolve());
  const confirmDestructive = useConfirmDestructive();
  const { onCleared, onClearFailed } = useEncounterEdit();

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      readJson<{ templates?: HistoryTemplate[]; subjectSections?: HistorySubjectSection[]; catalogs?: HistoryCatalogs; error?: string }>(`${clinicalGraphApiBase()}/clinical-graph/hpi/definition`),
      readJson<{ complaints?: EncounterComplaint[]; error?: string }>(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/complaints`),
      readJson<{ answers?: HistoryTemplateAnswer[]; carriedForwardAnswers?: CarriedForwardHistoryAnswer[]; reviewAttestations?: HistoryReviewAttestation[]; followUpPrefills?: HistoryTemplateAnswer[]; templateNarratives?: Array<{ complaintId: string; narrative: string }>; requiresAggregateRefresh?: boolean; error?: string }>(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/hpi`),
    ]).then(([definition, complaintRecord, history]) => {
      if (cancelled) return;
      setTemplates(definition.templates ?? []);
      setSubjectSections(definition.subjectSections ?? []);
      setCatalogs(definition.catalogs ?? {});
      setComplaints(complaintRecord.complaints ?? []);
      const loadedAnswers = history.answers ?? [];
      latestAnswers.current = loadedAnswers;
      persistedAnswerReferences.current = new Map(loadedAnswers.flatMap((answer) =>
        answer.observationReference ? [[answer.id, answer.observationReference] as const] : []
      ));
      setAnswers(loadedAnswers);
      setFollowUpPrefills(history.followUpPrefills ?? []);
      setCarriedForwardAnswers(history.carriedForwardAnswers ?? []);
      setReviewAttestations(history.reviewAttestations ?? []);
      setNarratives(Object.fromEntries((history.templateNarratives ?? []).map((row) => [row.complaintId, row.narrative])));
      if (history.requiresAggregateRefresh && (complaintRecord.complaints ?? []).length > 0) {
        void queueSave().catch(() => undefined);
      }
    }).catch((caught) => {
      if (!cancelled) setSaveState({ status: "error", reason: errorMessage(caught) });
    });
    return () => {
      cancelled = true;
      for (const timer of debounceTimers.current.values()) clearTimeout(timer);
      debounceTimers.current.clear();
    };
  }, [encounterId]);

  useEffect(() => {
    if (saveState.status !== "saved") return;
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [saveState.status]);

  const activeComplaints = complaints.slice().sort((left, right) => left.ordinal - right.ordinal);
  const summary = activeComplaints.map((complaint) => narratives[complaint.id] || complaint.renderedNarrative).filter(Boolean).join(" ");
  const complaintState = historyComplaintState(activeComplaints, templates, answers);
  const complete = complaintState === "charted";

  async function addComplaint(template: HistoryTemplate) {
    if (adding) return;
    setAdding(true);
    setSaveState({ status: "idle" });
    try {
      const result = await postJson<{ complaints?: EncounterComplaint[]; error?: string }>(
        `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/complaints`,
        { action: "create-template", patientReference, templateKey: template.complaint },
      );
      setComplaints(result.complaints ?? []);
      await queueSave();
      onSaved({ completed: false, summary: complaintSummary(result.complaints ?? [], narratives), operator: "ODOS History template" }, true);
    } catch (caught) {
      setSaveState({ status: "error", reason: errorMessage(caught) });
    } finally {
      setAdding(false);
    }
  }

  function changeAnswer(nextAnswer: HistoryTemplateAnswer | undefined, prior: HistoryTemplateAnswer | undefined) {
    if (!nextAnswer) {
      if (prior) void clearAnswer(prior);
      return;
    }
    if (nextAnswer.sectionId === "presentation" && nextAnswer.value.kind === "selection") {
      const template = templates.find((candidate) => candidate.complaint === nextAnswer.templateKey);
      const presentationCode = nextAnswer.value.code;
      const inactiveSectionIds = new Set(template?.sections.filter((section) => section.on && section.on !== presentationCode).map((section) => section.id));
      const inactiveAnswers = latestAnswers.current.filter((answer) =>
        answer.complaintId === nextAnswer.complaintId && inactiveSectionIds.has(answer.sectionId)
      );
      if (inactiveAnswers.length) {
        void changePresentation(nextAnswer, inactiveAnswers);
        return;
      }
    }
    applyAnswer(nextAnswer);
  }

  function applyAnswer(nextAnswer: HistoryTemplateAnswer) {
    let next = replaceAnswer(latestAnswers.current, nextAnswer);
    if (nextAnswer.sectionId === "presentation" && nextAnswer.value.kind === "selection" && nextAnswer.value.code === "follow-up") {
      for (const prefill of followUpPrefills.filter((candidate) => candidate.complaintId === nextAnswer.complaintId)) {
        if (!next.some((candidate) => candidate.id === prefill.id)) next = [...next, prefill];
      }
    }
    latestAnswers.current = next;
    setAnswers(next);
    scheduleSave(nextAnswer.id);
  }

  async function changePresentation(nextAnswer: HistoryTemplateAnswer, inactiveAnswers: HistoryTemplateAnswer[]) {
    for (const timer of debounceTimers.current.values()) clearTimeout(timer);
    debounceTimers.current.clear();
    try {
      await saveQueue.current;
      const references = inactiveAnswers.flatMap((answer) => {
        const observationReference = answer.observationReference ?? persistedAnswerReferences.current.get(answer.id);
        return observationReference ? [observationReference] : [];
      });
      const result = references.length ? await voidEncounterEntries(encounterReference, {
        scope: "observation",
        observationReference: references,
        sectionKey: "hpi",
        label: "Follow-up details",
      }) : undefined;
      const inactiveIds = new Set(inactiveAnswers.map((answer) => answer.id));
      latestAnswers.current = latestAnswers.current.filter((answer) => !inactiveIds.has(answer.id));
      for (const answer of inactiveAnswers) persistedAnswerReferences.current.delete(answer.id);
      applyAnswer(nextAnswer);
      if (result) onCleared?.({ scope: "observation", result });
    } catch (caught) {
      onClearFailed?.({ scope: "observation", error: caught });
      setSaveState({ status: "error", reason: errorMessage(caught) });
    }
  }

  async function clearAnswer(answer: HistoryTemplateAnswer) {
    const pending = debounceTimers.current.get(answer.id);
    if (pending) clearTimeout(pending);
    debounceTimers.current.delete(answer.id);
    const next = latestAnswers.current.filter((candidate) => candidate.id !== answer.id);
    latestAnswers.current = next;
    setAnswers(next);
    let observationReference = answer.observationReference;
    try {
      await saveQueue.current;
      observationReference ??= persistedAnswerReferences.current.get(answer.id);
      if (!observationReference) return;
      const result = await voidEncounterEntries(encounterReference, {
        scope: "observation",
        observationReference,
        sectionKey: answerSectionKey(answer),
        label: answer.optionCode ?? "History value",
      });
      persistedAnswerReferences.current.delete(answer.id);
      await queueSave();
      onCleared?.({ scope: "observation", result });
    } catch (caught) {
      const restored = observationReference ? { ...answer, observationReference } : answer;
      const restoredAnswers = replaceAnswer(latestAnswers.current, restored);
      latestAnswers.current = restoredAnswers;
      setAnswers(restoredAnswers);
      onClearFailed?.({ scope: "observation", error: caught });
      setSaveState({ status: "error", reason: errorMessage(caught) });
    }
  }

  async function removeTyped(answer: HistoryTemplateAnswer, label: string) {
    if (!answer.observationReference) {
      await clearAnswer(answer);
      return;
    }
    if (!(await confirmDestructive(removeValueConfirmSpec(label, "typed detail")))) return;
    await clearAnswer(answer);
  }

  async function removeComplaint(complaint: EncounterComplaint) {
    const label = complaint.freeTextLabel ?? templates.find((candidate) => candidate.complaint === complaint.templateKey)?.label ?? "complaint";
    if (!(await confirmDestructive(removeValueConfirmSpec(label, "composed narrative")))) return;
    try {
      for (const answer of latestAnswers.current.filter((candidate) => candidate.complaintId === complaint.id)) {
        const pending = debounceTimers.current.get(answer.id);
        if (pending) clearTimeout(pending);
        debounceTimers.current.delete(answer.id);
      }
      await saveQueue.current;
      const result = await voidEncounterEntries(encounterReference, {
        scope: "finding",
        findingKey: `hpi-complaint:${complaint.id}`,
        sectionKey: "hpi",
        label,
      });
      const remainingComplaints = complaints.filter((candidate) => candidate.id !== complaint.id);
      const removedAnswers = latestAnswers.current.filter((candidate) => candidate.complaintId === complaint.id);
      const remainingAnswers = latestAnswers.current.filter((candidate) => candidate.complaintId !== complaint.id);
      setComplaints(remainingComplaints);
      setAnswers(remainingAnswers);
      latestAnswers.current = remainingAnswers;
      for (const answer of removedAnswers) {
        persistedAnswerReferences.current.delete(answer.id);
      }
      if (remainingComplaints.length) await queueSave();
      onCleared?.({ scope: "finding", result });
    } catch (caught) {
      onClearFailed?.({ scope: "finding", error: caught });
      setSaveState({ status: "error", reason: errorMessage(caught) });
    }
  }

  async function reviewSubjectSection(declaration: HistorySubjectSection) {
    try {
      setReviewErrors((current) => ({ ...current, [declaration.key]: "" }));
      const attestation = await postJson<HistoryReviewAttestation & { error?: string }>(
        `${clinicalGraphApiBase()}/clinical-graph/history/review`,
        { patientReference, encounterReference, sectionKey: declaration.key },
      );
      setReviewAttestations((current) => [
        ...current.filter((candidate) => candidate.sectionKey !== declaration.key),
        attestation,
      ]);
    } catch (caught) {
      setReviewErrors((current) => ({ ...current, [declaration.key]: errorMessage(caught) }));
    }
  }

  function scheduleSave(fieldKey: string) {
    const current = debounceTimers.current.get(fieldKey);
    if (current) clearTimeout(current);
    debounceTimers.current.set(fieldKey, setTimeout(() => {
      debounceTimers.current.delete(fieldKey);
      void queueSave().catch(() => undefined);
    }, 800));
  }

  function queueSave(): Promise<void> {
    const run = saveQueue.current.then(() => saveHistory(latestAnswers.current));
    saveQueue.current = run.catch(() => undefined);
    return run;
  }

  async function saveHistory(snapshot: HistoryTemplateAnswer[]) {
    setSaveState({ status: "saving" });
    try {
      const result = await postJson<{
        answers?: HistoryTemplateAnswer[];
        templateNarratives?: Array<{ complaintId: string; narrative: string }>;
        retiredReviewSections?: string[];
        error?: string;
      }>(`${clinicalGraphApiBase()}/clinical-graph/hpi`, {
        patientReference,
        encounterReference,
        templateAnswers: snapshot.map(stripObservationReference),
      });
      const savedAnswers = result.answers ?? snapshot;
      for (const answer of savedAnswers) {
        if (answer.observationReference) persistedAnswerReferences.current.set(answer.id, answer.observationReference);
      }
      latestAnswers.current = mergeSavedReferences(latestAnswers.current, savedAnswers);
      setAnswers((current) => mergeSavedReferences(current, savedAnswers));
      if (result.retiredReviewSections?.length) {
        const retired = new Set(result.retiredReviewSections);
        setReviewAttestations((current) => current.filter((attestation) => !retired.has(attestation.sectionKey)));
      }
      const nextNarratives = {
        ...narratives,
        ...Object.fromEntries((result.templateNarratives ?? []).map((row) => [row.complaintId, row.narrative])),
      };
      setNarratives(nextNarratives);
      const at = Date.now();
      setClock(at);
      setSaveState({ status: "saved", at });
      const nextComplete = complaints.length > 0 && complaints.every((complaint) => {
        const template = templates.find((candidate) => candidate.complaint === complaint.templateKey);
        return template ? historySectionComplete(template, savedAnswers.filter((answer) => answer.complaintId === complaint.id)) : false;
      });
      onSaved({
        completed: nextComplete,
        summary: complaintSummary(complaints, nextNarratives),
        savedAt: new Date(at).toISOString(),
        operator: "ODOS History autosave",
      }, true);
    } catch (caught) {
      setSaveState({ status: "error", reason: errorMessage(caught) });
      throw caught;
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl">
        <header className={`odos-hpi-border rounded border bg-bg-panel/80 p-4 ${saveState.status === "error" ? "border-red-400/70" : ""}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={!folded} onClick={() => setFolded((value) => !value)}>
              <span className="odos-hpi-faint text-xs font-semibold uppercase tracking-wider">History</span>
              <h2 className="odos-hpi-text mt-1 text-lg font-semibold">Chief Complaint &amp; HPI</h2>
              {folded && <p className="odos-hpi-muted mt-2 truncate text-sm">{summary || "Not started"}</p>}
            </button>
            <div className="flex items-center gap-2">
              <span aria-label={completenessLabel(complaintState)} className={`text-xs font-semibold ${complete ? "text-emerald-200" : "odos-hpi-faint"}`}>
                {completenessLabel(complaintState)}
              </span>
              <button type="button" className="sidebar-button" onClick={() => setEditMode((value) => !value)}>{editMode ? "Done" : "Edit"}</button>
              <ClearSectionButton
                encounterReference={encounterReference}
                sectionKey={["hpi", ...subjectSections.map((section) => section.key)]}
                label="History"
                hasRecorded={complaints.length > 0 || answers.length > 0 || reviewAttestations.length > 0}
                onBeforeClear={async () => {
                  for (const timer of debounceTimers.current.values()) clearTimeout(timer);
                  debounceTimers.current.clear();
                  await saveQueue.current;
                }}
                onCleared={(result) => {
                  setComplaints([]);
                  setAnswers([]);
                  latestAnswers.current = [];
                  persistedAnswerReferences.current.clear();
                  setReviewAttestations([]);
                  setNarratives({});
                  setSaveState({ status: "idle" });
                  onSaved({ completed: false, summary: "Not started" }, true);
                  onCleared?.({ scope: "section", result });
                }}
              />
            </div>
          </div>
          <SaveIndicator state={saveState} clock={clock} onRetry={() => { void queueSave().catch(() => undefined); }} />
        </header>

        {!folded && <div className="mt-4 space-y-4">
          {templates.length === 0 && <p className="odos-hpi-muted text-sm">Loading history templates…</p>}
          {activeComplaints.map((complaint, index) => {
            const template = templates.find((candidate) => candidate.complaint === complaint.templateKey);
            if (!template) return null;
            const complaintAnswers = answers.filter((answer) => answer.complaintId === complaint.id);
            return (
              <article key={complaint.id} className="odos-hpi-border rounded border bg-bg-panel/70 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="odos-hpi-text font-semibold">{index + 1}. {template.label} {index === 0 && <span className="ml-2 rounded bg-brand/20 px-2 py-0.5 text-[11px] text-brand-light">Primary</span>}</h3>
                    <p className="odos-hpi-muted mt-2 text-sm leading-6">{narratives[complaint.id] || "Choose a presentation to begin the narrative."}</p>
                  </div>
                  {editMode && <button type="button" className="sidebar-button" onClick={() => void removeComplaint(complaint)}>Remove</button>}
                </div>
                <HistoryTemplateEditor
                  complaintId={complaint.id}
                  template={template}
                  catalogs={catalogs}
                  answers={complaintAnswers}
                  narrative={narratives[complaint.id] ?? ""}
                  editMode={editMode}
                  onChange={changeAnswer}
                  onRemoveTyped={(answer, label) => void removeTyped(answer, label)}
                />
              </article>
            );
          })}

          {subjectSections.map((declaration) => {
            const currentAnswers = answers.filter((answer) => answer.subjectScope === declaration.subjectScope && answer.templateKey === declaration.key);
            const carried = carriedForwardAnswers.filter((row) => row.answer.templateKey === declaration.key);
            const attestation = reviewAttestations.find((candidate) => candidate.sectionKey === declaration.key);
            const state = historySubjectSectionState(declaration, currentAnswers);
            return <article key={declaration.key} className="odos-hpi-border rounded border bg-bg-panel/70 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="odos-hpi-text font-semibold">{declaration.label}</h3>
                  <p className={`mt-1 text-xs font-semibold ${state === "charted" ? "text-emerald-200" : "odos-hpi-faint"}`}>{completenessLabel(state)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" className="sidebar-button" onClick={() => setEditMode((value) => !value)}>{editMode ? "Done" : "Edit"}</button>
                  <ClearSectionButton
                    encounterReference={encounterReference}
                    sectionKey={declaration.key}
                    label={declaration.label}
                    hasRecorded={currentAnswers.length > 0 || Boolean(attestation)}
                    onBeforeClear={async () => {
                      for (const timer of debounceTimers.current.values()) clearTimeout(timer);
                      debounceTimers.current.clear();
                      await saveQueue.current;
                    }}
                    onCleared={(result) => {
                      const removed = latestAnswers.current.filter((answer) => answer.subjectScope === declaration.subjectScope && answer.templateKey === declaration.key);
                      latestAnswers.current = latestAnswers.current.filter((answer) => !removed.includes(answer));
                      setAnswers(latestAnswers.current);
                      for (const answer of removed) persistedAnswerReferences.current.delete(answer.id);
                      setReviewAttestations((current) => current.filter((candidate) => candidate.sectionKey !== declaration.key));
                      onCleared?.({ scope: "section", result });
                    }}
                  />
                </div>
              </div>
              {carried.length > 0 && <CarriedForwardStrip
                declaration={declaration}
                catalogs={catalogs}
                rows={carried}
                attestation={attestation}
                canReviewNoChange={currentAnswers.length === 0}
                reviewError={reviewErrors[declaration.key]}
                onReview={() => void reviewSubjectSection(declaration)}
              />}
              <HistorySubjectSectionEditor
                encounterId={encounterId}
                declaration={declaration}
                catalogs={catalogs}
                answers={currentAnswers}
                editMode={editMode}
                onChange={changeAnswer}
                onRemoveTyped={(answer, label) => void removeTyped(answer, label)}
              />
            </article>;
          })}

          <div className="odos-hpi-border rounded border border-dashed bg-bg-panel/40 p-4">
            <p className="odos-hpi-muted text-sm font-semibold">Add complaint</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {templates.map((template) => <button key={template.complaint} type="button" className="sidebar-button" disabled={adding} onClick={() => void addComplaint(template)}>{template.label}</button>)}
            </div>
          </div>
        </div>}
      </div>
    </section>
  );
}

export function HistoryTemplateEditor({
  complaintId,
  template,
  catalogs,
  answers,
  narrative,
  editMode,
  onChange,
  onRemoveTyped,
}: {
  complaintId: string;
  template: HistoryTemplate;
  catalogs: HistoryCatalogs;
  answers: HistoryTemplateAnswer[];
  narrative: string;
  editMode: boolean;
  onChange: (next: HistoryTemplateAnswer | undefined, prior: HistoryTemplateAnswer | undefined) => void;
  onRemoveTyped: (answer: HistoryTemplateAnswer, label: string) => void;
}) {
  const presentation = answers.find((answer) => answer.sectionId === "presentation");
  const presentationCode = presentation?.value.kind === "selection" ? presentation.value.code : undefined;
  const sections = presentationCode
    ? template.sections.filter((section) => !section.on || section.on === presentationCode)
    : [];

  function put(sectionId: string, value: HistoryAnswerValue, optionCode?: string, eye?: "OD" | "OS" | "OU") {
    const prior = answers.find((answer) => answer.sectionId === sectionId && answer.optionCode === optionCode && answer.eye === eye);
    onChange({
      id: prior?.id ?? historyAnswerId(complaintId, sectionId, optionCode, eye),
      complaintId,
      templateKey: template.complaint,
      sectionId,
      ...(optionCode ? { optionCode } : {}),
      ...(eye ? { eye } : {}),
      ...(prior?.observationReference ? { observationReference: prior.observationReference } : {}),
      value,
    }, prior);
  }

  function triState(section: HistoryTemplateSection, optionCode: string, eye?: "OD" | "OS") {
    const prior = answers.find((answer) => answer.sectionId === section.id && answer.optionCode === optionCode && answer.eye === eye);
    const current = prior?.value.kind === "tri-state" ? prior.value.status : undefined;
    const next = cycleHistoryTriState(current);
    if (!next) onChange(undefined, prior);
    else put(section.id, { kind: "tri-state", status: next }, optionCode, eye);
  }

  return (
    <div className="mt-5 space-y-5">
      <TemplateField label="Presentation" required>
        <div className="flex flex-wrap gap-2">{(catalogs[template.presentations] ?? []).map((option) => {
          const selected = presentationCode === option.code;
          return <button key={option.code} type="button" aria-pressed={selected} className={chipClass(selected ? "positive" : undefined)} onClick={() => put("presentation", { kind: "selection", code: option.code })}>{option.display}</button>;
        })}</div>
      </TemplateField>

      {sections.map((section) => <TemplateSection
        key={section.id}
        section={section}
        catalogs={catalogs}
        answers={answers}
        editMode={editMode}
        onTriState={(optionCode, eye) => triState(section, optionCode, eye)}
        onPut={(value, optionCode, eye) => put(section.id, value, optionCode, eye)}
        onRemoveTyped={onRemoveTyped}
      />)}

      <NarrativeEditor
        complaintId={complaintId}
        templateKey={template.complaint}
        answers={answers}
        narrative={narrative}
        editMode={editMode}
        onChange={onChange}
        onRemoveTyped={onRemoveTyped}
      />
    </div>
  );
}

export function HistorySubjectSectionEditor({
  encounterId,
  declaration,
  catalogs,
  answers,
  editMode,
  onChange,
  onRemoveTyped,
}: {
  encounterId: string;
  declaration: HistorySubjectSection;
  catalogs: HistoryCatalogs;
  answers: HistoryTemplateAnswer[];
  editMode: boolean;
  onChange: (next: HistoryTemplateAnswer | undefined, prior: HistoryTemplateAnswer | undefined) => void;
  onRemoveTyped: (answer: HistoryTemplateAnswer, label: string) => void;
}) {
  function put(sectionId: string, value: HistoryAnswerValue, optionCode?: string, eye?: "OD" | "OS" | "OU") {
    const prior = answers.find((answer) => answer.sectionId === sectionId && answer.optionCode === optionCode && answer.eye === eye);
    onChange({
      id: prior?.id ?? subjectHistoryAnswerId(encounterId, declaration.key, sectionId, optionCode, eye),
      subjectScope: declaration.subjectScope,
      templateKey: declaration.key,
      sectionId,
      ...(optionCode ? { optionCode } : {}),
      ...(eye ? { eye } : {}),
      ...(prior?.observationReference ? { observationReference: prior.observationReference } : {}),
      value,
    }, prior);
  }

  function triState(section: HistoryTemplateSection, optionCode: string, eye?: "OD" | "OS") {
    const prior = answers.find((answer) => answer.sectionId === section.id && answer.optionCode === optionCode && answer.eye === eye);
    const current = prior?.value.kind === "tri-state" ? prior.value.status : undefined;
    const next = cycleHistoryTriState(current);
    if (!next) onChange(undefined, prior);
    else put(section.id, { kind: "tri-state", status: next }, optionCode, eye);
  }

  return <div className="mt-5 space-y-5">{declaration.sections.map((section) => <TemplateSection
    key={section.id}
    section={section}
    catalogs={catalogs}
    answers={answers}
    editMode={editMode}
    onTriState={(optionCode, eye) => triState(section, optionCode, eye)}
    onPut={(value, optionCode, eye) => put(section.id, value, optionCode, eye)}
    onRemoveTyped={onRemoveTyped}
  />)}</div>;
}

function TemplateSection({ section, catalogs, answers, editMode, onTriState, onPut, onRemoveTyped }: {
  section: HistoryTemplateSection;
  catalogs: HistoryCatalogs;
  answers: HistoryTemplateAnswer[];
  editMode: boolean;
  onTriState: (optionCode: string, eye?: "OD" | "OS") => void;
  onPut: (value: HistoryAnswerValue, optionCode?: string, eye?: "OD" | "OS" | "OU") => void;
  onRemoveTyped: (answer: HistoryTemplateAnswer, label: string) => void;
}) {
  const answer = answers.find((candidate) => candidate.sectionId === section.id && !candidate.optionCode);
  if ((section.type === "symptoms" || section.type === "quality" || section.type === "risk_factors" || section.type === "treatment" || section.type === "presents_for") && section.catalog) {
    return <TemplateField label={section.label} required={section.required}>
      <div className="space-y-2">{(catalogs[section.catalog] ?? []).map((option) => <CatalogOptionControl
        key={option.code}
        section={section}
        option={option}
        answers={answers}
        onTriState={onTriState}
        onPut={onPut}
      />)}</div>
    </TemplateField>;
  }
  if (section.type === "severity") {
    const value = answer?.value.kind === "severity" ? answer.value.level : "";
    return <TemplateField label={section.label}><select className="sidebar-input max-w-xs" value={value} onChange={(event) => event.target.value && onPut({ kind: "severity", level: event.target.value as "mild" | "moderate" | "severe" })}><option value="" disabled>Select…</option><option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option></select><TypedRemove editMode={editMode} answer={answer} label={section.label} onRemove={onRemoveTyped} /></TemplateField>;
  }
  if (section.type === "duration") {
    const value = answer?.value.kind === "duration" ? answer.value : undefined;
    return <TemplateField label={`How long: ${section.label}`}><div className="flex max-w-md gap-2"><input aria-label={`${section.label} duration value`} className="sidebar-input" type="number" min={1} value={value?.value ?? ""} onChange={(event) => event.target.value && onPut({ kind: "duration", value: Number(event.target.value), unit: value?.unit ?? "days" })} /><select aria-label={`${section.label} duration unit`} className="sidebar-input" value={value?.unit ?? "days"} onChange={(event) => onPut({ kind: "duration", value: value?.value ?? 1, unit: event.target.value as "days" | "weeks" | "months" | "years" })}><option value="days">Days</option><option value="weeks">Weeks</option><option value="months">Months</option><option value="years">Years</option></select></div><TypedRemove editMode={editMode} answer={answer} label={section.label} onRemove={onRemoveTyped} /></TemplateField>;
  }
  if (section.type === "interval") {
    const value = answer?.value.kind === "interval" ? answer.value : undefined;
    return <TemplateField label={section.label}><div className="grid gap-2 md:grid-cols-[12rem_1fr]"><select className="sidebar-input" value={value?.code ?? ""} onChange={(event) => event.target.value && onPut({ kind: "interval", code: event.target.value as "better" | "same" | "worse", note: value?.note })}><option value="" disabled>Select…</option><option value="better">Better</option><option value="same">Same</option><option value="worse">Worse</option></select><input aria-label={`${section.label} note`} className="sidebar-input" placeholder="Optional note" value={value?.note ?? ""} onChange={(event) => onPut({ kind: "interval", code: value?.code ?? "same", note: event.target.value })} /></div><TypedRemove editMode={editMode} answer={answer} label={section.label} onRemove={onRemoveTyped} /></TemplateField>;
  }
  if (section.type === "laterality") {
    const value = answer?.value.kind === "laterality" ? answer.value : undefined;
    return <TemplateField label={section.label}><select className="sidebar-input max-w-xs" value={value?.code ?? ""} onChange={(event) => event.target.value && onPut({ kind: "laterality", code: event.target.value as "OD-worse" | "OS-worse" | "equal" | "other" })}><option value="" disabled>Select…</option><option value="OD-worse">OD worse</option><option value="OS-worse">OS worse</option><option value="equal">Equal</option><option value="other">Other</option></select><TypedRemove editMode={editMode} answer={answer} label={section.label} onRemove={onRemoveTyped} /></TemplateField>;
  }
  if (section.type === "numeric") {
    const value = answer?.value.kind === "numeric" ? answer.value : undefined;
    return <TemplateField label={section.label}><input className="sidebar-input max-w-xs" type="number" value={value?.value ?? ""} onChange={(event) => event.target.value && onPut({ kind: "numeric", value: Number(event.target.value), unit: value?.unit })} /><TypedRemove editMode={editMode} answer={answer} label={section.label} onRemove={onRemoveTyped} /></TemplateField>;
  }
  if (section.type === "text") {
    const value = answer?.value.kind === "text" ? answer.value.text : "";
    return <TemplateField label={section.label}><textarea className="sidebar-input min-h-24 resize-y" value={value} onChange={(event) => onPut({ kind: "text", text: event.target.value })} /><TypedRemove editMode={editMode} answer={answer} label={section.label} onRemove={onRemoveTyped} /></TemplateField>;
  }
  return null;
}

function CatalogOptionControl({ section, option, answers, onTriState, onPut }: {
  section: HistoryTemplateSection;
  option: HistoryCatalogs[string][number];
  answers: HistoryTemplateAnswer[];
  onTriState: (optionCode: string, eye?: "OD" | "OS") => void;
  onPut: (value: HistoryAnswerValue, optionCode?: string, eye?: "OD" | "OS" | "OU") => void;
}) {
  const perEye = option.per_eye ?? section.per_eye ?? false;
  if (!perEye) {
    const selected = answers.find((candidate) => candidate.sectionId === section.id && candidate.optionCode === option.code && !candidate.eye);
    const state = selected?.value.kind === "tri-state" ? selected.value.status : undefined;
    const note = selected?.value.kind === "tri-state" ? selected.value.note ?? "" : "";
    return <div className="flex flex-wrap items-center gap-2">
      <button type="button" aria-label={`${option.display}: ${state ?? "unasked"}`} aria-pressed={state === "positive"} className={chipClass(state)} onClick={() => onTriState(option.code)}>{state === "negative" ? `no ${option.display}` : option.display}</button>
      {option.note_on_positive && state === "positive" && <input aria-label={`${option.display} note`} className="sidebar-input min-w-56 flex-1" placeholder="Optional note" value={note} onChange={(event) => onPut({ kind: "tri-state", status: "positive", note: event.target.value }, option.code)} />}
    </div>;
  }
  return <div className="flex flex-wrap items-center gap-2">
    <span className="odos-hpi-muted min-w-36 text-sm">{option.display}</span>
    {(["OD", "OS"] as const).map((eye) => {
      const selected = answers.find((candidate) => candidate.sectionId === section.id && candidate.optionCode === option.code && candidate.eye === eye);
      const state = selected?.value.kind === "tri-state" ? selected.value.status : undefined;
      const note = selected?.value.kind === "tri-state" ? selected.value.note ?? "" : "";
      return <span key={eye} className="inline-flex flex-wrap items-center gap-2">
        <button type="button" aria-label={`${option.display} ${eye}: ${state ?? "unasked"}`} aria-pressed={state === "positive"} className={chipClass(state)} onClick={() => onTriState(option.code, eye)}>{state === "negative" ? `no ${eye}` : eye}</button>
        {option.note_on_positive && state === "positive" && <input aria-label={`${option.display} ${eye} note`} className="sidebar-input min-w-44" placeholder="Optional note" value={note} onChange={(event) => onPut({ kind: "tri-state", status: "positive", note: event.target.value }, option.code, eye)} />}
      </span>;
    })}
  </div>;
}

function NarrativeEditor({ complaintId, templateKey, answers, narrative, editMode, onChange, onRemoveTyped }: {
  complaintId: string;
  templateKey: string;
  answers: HistoryTemplateAnswer[];
  narrative: string;
  editMode: boolean;
  onChange: (next: HistoryTemplateAnswer | undefined, prior: HistoryTemplateAnswer | undefined) => void;
  onRemoveTyped: (answer: HistoryTemplateAnswer, label: string) => void;
}) {
  const override = answers.find((answer) => answer.sectionId === "narrative-override");
  const overrideText = override?.value.kind === "text" ? override.value.text : undefined;
  const rows = Math.max(6, Math.ceil(Math.max(narrative.length, overrideText?.length ?? 0) / 80) + 1);
  function enableOverride() {
    onChange({
      id: override?.id ?? historyAnswerId(complaintId, "narrative-override"),
      complaintId,
      templateKey,
      sectionId: "narrative-override",
      ...(override?.observationReference ? { observationReference: override.observationReference } : {}),
      value: { kind: "text", text: overrideText ?? narrative },
    }, override);
  }
  return <TemplateField label="History narrative">
    {overrideText === undefined
      ? <><p className="odos-hpi-muted text-sm leading-6">{narrative || "The declaration composes the narrative as answers are recorded."}</p><button type="button" className="sidebar-button mt-3" onClick={enableOverride}>Override</button></>
      : <><textarea aria-label="History narrative override" className="sidebar-input min-h-32 resize-y" rows={rows} value={overrideText} onChange={(event) => { if (override) onChange({ ...override, value: { kind: "text", text: event.target.value } }, override); }} /><TypedRemove editMode={editMode} answer={override} label="History narrative override" onRemove={onRemoveTyped} /></>}
  </TemplateField>;
}

function TemplateField({ label, required = false, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return <fieldset className="odos-hpi-border rounded border p-4"><legend className="odos-hpi-muted px-2 text-sm font-semibold">{label}{required ? " · required" : ""}</legend>{children}</fieldset>;
}

function TypedRemove({ editMode, answer, label, onRemove }: { editMode: boolean; answer: HistoryTemplateAnswer | undefined; label: string; onRemove: (answer: HistoryTemplateAnswer, label: string) => void }) {
  return editMode && answer ? <button type="button" className="sidebar-button mt-2" onClick={() => onRemove(answer, label)}>Remove</button> : null;
}

function CarriedForwardStrip({ declaration, catalogs, rows, attestation, canReviewNoChange, reviewError, onReview }: {
  declaration: HistorySubjectSection;
  catalogs: HistoryCatalogs;
  rows: CarriedForwardHistoryAnswer[];
  attestation: HistoryReviewAttestation | undefined;
  canReviewNoChange: boolean;
  reviewError: string | undefined;
  onReview: () => void;
}) {
  return <div aria-label={`${declaration.label} on this chart`} className="mt-4 rounded border border-sky-500/40 bg-sky-950/20 p-4">
    <p className="text-xs font-semibold uppercase tracking-wider text-sky-200">On this chart · prior encounters</p>
    <ul className="mt-2 space-y-1 text-sm text-sky-50">{rows.map((row) => {
      const section = declaration.sections.find((candidate) => candidate.id === row.answer.sectionId);
      const option = section?.catalog ? catalogs[section.catalog]?.find((candidate) => candidate.code === row.answer.optionCode) : undefined;
      const state = row.answer.value.kind === "tri-state" ? row.answer.value.status : undefined;
      const note = row.answer.value.kind === "tri-state" ? row.answer.value.note : undefined;
      const label = `${state === "negative" ? "No " : ""}${option?.display ?? row.answer.optionCode ?? section?.label ?? "History value"}${row.answer.eye ? ` ${row.answer.eye}` : ""}`;
      return <li key={row.answer.observationReference ?? row.answer.id}>{label}{note ? ` · ${note}` : ""} <span className="odos-hpi-faint">· {row.recordedAt.slice(0, 10)}</span></li>;
    })}</ul>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" className="sidebar-button" disabled={!canReviewNoChange} title={canReviewNoChange ? undefined : "This section has edits on today's encounter."} onClick={onReview}>Reviewed today, no change</button>
      {attestation && <p className="text-xs text-emerald-200">Reviewed by {attestation.actorReference} · {attestation.recordedAt.slice(0, 10)}</p>}
      {reviewError && <p role="alert" className="text-xs text-red-200">Review failed · {reviewError}</p>}
    </div>
  </div>;
}

function SaveIndicator({ state, clock, onRetry }: { state: SaveState; clock: number; onRetry: () => void }) {
  if (state.status === "idle") return null;
  if (state.status === "saving") return <p role="status" className="odos-hpi-faint mt-2 text-xs">saving…</p>;
  if (state.status === "saved") return <p role="status" className="mt-2 text-xs text-emerald-200">saved · {relativeSavedTime(clock - state.at)}</p>;
  return <p role="alert" className="mt-2 text-sm text-red-200">Save failed · {state.reason} <button type="button" className="ml-2 underline" onClick={onRetry}>Retry</button></p>;
}

export function cycleHistoryTriState(value: HistoryTriState | undefined): HistoryTriState | undefined {
  return value === undefined ? "positive" : value === "positive" ? "negative" : undefined;
}

export function historySectionComplete(template: HistoryTemplate, answers: HistoryTemplateAnswer[]): boolean {
  const presentation = answers.find((answer) => answer.sectionId === "presentation");
  if (presentation?.value.kind !== "selection") return false;
  const presentationCode = presentation.value.code;
  return template.sections
    .filter((section) => (!section.on || section.on === presentationCode) && section.required)
    .every((section) => answers.some((answer) => answer.sectionId === section.id));
}

type HistoryCompletenessState = "not-started" | "started" | "charted";

export function historyComplaintState(
  complaints: EncounterComplaint[],
  templates: HistoryTemplate[],
  answers: HistoryTemplateAnswer[],
): HistoryCompletenessState {
  if (answers.filter((answer) => answer.complaintId).length === 0) return "not-started";
  return complaints.length > 0 && complaints.every((complaint) => {
    const template = templates.find((candidate) => candidate.complaint === complaint.templateKey);
    return template ? historySectionComplete(template, answers.filter((answer) => answer.complaintId === complaint.id)) : false;
  }) ? "charted" : "started";
}

function historySubjectSectionState(
  declaration: HistorySubjectSection,
  answers: HistoryTemplateAnswer[],
): HistoryCompletenessState {
  if (answers.length === 0) return "not-started";
  const hasAnchor = answers.some((answer) => answer.sectionId === declaration.completionAnchor);
  const hasRequired = declaration.sections.filter((section) => section.required)
    .every((section) => answers.some((answer) => answer.sectionId === section.id));
  return hasAnchor && hasRequired ? "charted" : "started";
}

function completenessLabel(state: HistoryCompletenessState): string {
  if (state === "not-started") return "Not started";
  return state === "started" ? "Started" : "Charted";
}

function replaceAnswer(answers: HistoryTemplateAnswer[], answer: HistoryTemplateAnswer): HistoryTemplateAnswer[] {
  const index = answers.findIndex((candidate) => candidate.id === answer.id);
  if (index < 0) return [...answers, answer];
  return answers.map((candidate, candidateIndex) => candidateIndex === index ? answer : candidate);
}

function mergeSavedReferences(current: HistoryTemplateAnswer[], saved: HistoryTemplateAnswer[]): HistoryTemplateAnswer[] {
  const savedById = new Map(saved.map((answer) => [answer.id, answer]));
  return current.map((answer) => {
    const persisted = savedById.get(answer.id);
    return persisted?.observationReference ? { ...answer, observationReference: persisted.observationReference } : answer;
  });
}

function stripObservationReference(answer: HistoryTemplateAnswer): Omit<HistoryTemplateAnswer, "observationReference"> {
  const { observationReference: _observationReference, ...persisted } = answer;
  return persisted;
}

function historyAnswerId(complaintId: string, sectionId: string, optionCode = "value", eye?: "OD" | "OS" | "OU"): string {
  return `history-${complaintId}-${sectionId}-${optionCode}${eye ? `-${eye}` : ""}`.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 180);
}

function subjectHistoryAnswerId(encounterId: string, templateKey: string, sectionId: string, optionCode = "value", eye?: "OD" | "OS" | "OU"): string {
  return `history-${encounterId}-${templateKey}-${sectionId}-${optionCode}${eye ? `-${eye}` : ""}`.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 180);
}

function answerSectionKey(answer: HistoryTemplateAnswer): string {
  return answer.subjectScope ? answer.templateKey : "hpi";
}

function chipClass(state: HistoryTriState | undefined): string {
  if (state === "positive") return "rounded border border-brand bg-brand/20 px-3 py-2 text-sm text-brand-light";
  if (state === "negative") return "odos-hpi-muted rounded border border-slate-500/60 px-3 py-2 text-sm line-through";
  return "odos-hpi-border-strong odos-hpi-muted rounded border px-3 py-2 text-sm hover:border-brand/50";
}

function relativeSavedTime(ageMilliseconds: number): string {
  const minutes = Math.floor(Math.max(0, ageMilliseconds) / 60_000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}

function complaintSummary(complaints: EncounterComplaint[], narratives: Record<string, string>): string {
  return complaints.slice().sort((left, right) => left.ordinal - right.ordinal)
    .map((complaint) => narratives[complaint.id] || complaint.renderedNarrative)
    .filter(Boolean).join(" ");
}

async function readJson<T extends { error?: string }>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  const body = await response.json() as T;
  if (!response.ok) throw new Error(body.error ?? `History read failed: ${response.status}`);
  return body;
}

async function postJson<T extends { error?: string }>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as T;
  if (!response.ok) throw new Error(result.error ?? `History save failed: ${response.status}`);
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
