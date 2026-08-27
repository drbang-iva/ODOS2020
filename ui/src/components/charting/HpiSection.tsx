import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import {
  blankComplaintDraft,
  effectiveComplaintOptions,
  hpiElementCount,
  renderComplaintNarrative,
  type ComplaintDefinition,
  type ComplaintDraft,
  type ComplaintOption,
  type EncounterComplaint,
  type GenericComplaintOptions,
} from "../../lib/complaints";
import type { SectionSaveStatus } from "./types";
import { OdosSearchPicker } from "../inputs/OdosSearchPicker";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus, addAnother: boolean) => void;
}

type RosCategory = "eye" | "general";
type RosStatus = "" | "positive" | "negative";
type PendingHistoryCapture = { status: SectionSaveStatus; addAnother: boolean };

export interface HpiRosOption {
  code: string;
  display: string;
  category: RosCategory;
}

export const DEFAULT_HPI_ROS_OPTIONS: HpiRosOption[] = [
  { code: "vision-changes", display: "Vision changes", category: "eye" },
  { code: "eye-pain", display: "Eye pain", category: "eye" },
  { code: "floaters-flashes", display: "Floaters / flashes", category: "eye" },
  { code: "redness", display: "Redness", category: "eye" },
  { code: "discharge", display: "Discharge", category: "eye" },
  { code: "diabetes", display: "Diabetes", category: "general" },
  { code: "hypertension", display: "Hypertension", category: "general" },
];

const EMPTY_GENERIC_OPTIONS: GenericComplaintOptions = { conditions: [], qualities: [], treatments: [] };

export function HpiSection({ patientReference, encounterReference, onSaved }: Props) {
  const encounterId = encounterReference.slice("Encounter/".length);
  const [definitions, setDefinitions] = useState<ComplaintDefinition[]>([]);
  const [genericOptions, setGenericOptions] = useState<GenericComplaintOptions>(EMPTY_GENERIC_OPTIONS);
  const [complaints, setComplaints] = useState<EncounterComplaint[]>([]);
  const [draft, setDraft] = useState<ComplaintDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overrideDirty, setOverrideDirty] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [rosOptions, setRosOptions] = useState<HpiRosOption[]>(DEFAULT_HPI_ROS_OPTIONS);
  const [rosStatuses, setRosStatuses] = useState<Record<string, RosStatus>>({});
  const [reviewAttestations, setReviewAttestations] = useState<RosCategory[]>([]);
  const [newMedicalFlag, setNewMedicalFlag] = useState("");
  const [catalogMessage, setCatalogMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pendingHistoryCapture, setPendingHistoryCapture] = useState<PendingHistoryCapture | null>(null);
  const presentingConcernRef = useRef<HTMLInputElement>(null);
  const pendingNextConcernFocus = useRef(false);

  useEffect(() => {
    void load().catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [encounterReference]);

  useLayoutEffect(() => {
    if (!pendingNextConcernFocus.current || saving) return;
    pendingNextConcernFocus.current = false;
    const input = presentingConcernRef.current;
    if (!input || input.disabled) return;
    input.focus();
  }, [draft, saving]);

  const selectedDefinition = definitions.find((definition) => definition.stableKey === draft?.complaintKey);
  const options = effectiveComplaintOptions(genericOptions, selectedDefinition);
  const preview = draft ? renderComplaintNarrative(draft, selectedDefinition, genericOptions) : "";
  const topDefinitions = useMemo(() => definitions
    .filter((definition) => definition.status === "active")
    .sort((left, right) => left.seedRank - right.seedRank), [definitions]);
  const searchComplaintOptions = useMemo(() => async (query: string) => {
    const normalized = query.trim().toLocaleLowerCase();
    return topDefinitions
      .filter((definition) => `${definition.display} ${definition.stableKey}`.toLocaleLowerCase().includes(normalized))
      .map((definition) => ({
        value: definition.stableKey,
        label: definition.display,
        description: definition.stableKey,
        item: definition,
      }));
  }, [topDefinitions]);

  async function load() {
    const [definitionResponse, catalogResponse, complaintsResponse] = await Promise.all([
      fetch(`${clinicalGraphApiBase()}/clinical-graph/hpi/definition`, { headers: authHeaders() }),
      fetch(`${clinicalGraphApiBase()}/clinical-graph/complaint-definitions`, { headers: authHeaders() }),
      fetch(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/complaints`, { headers: authHeaders() }),
    ]);
    const definitionBody = await definitionResponse.json() as {
      definition?: { fields?: { reviewOfSystems?: { options?: Array<HpiRosOption & { active?: boolean }> } } };
      error?: string;
    };
    const catalogBody = await catalogResponse.json() as {
      definitions?: ComplaintDefinition[];
      genericOptions?: GenericComplaintOptions;
      error?: string;
    };
    const complaintsBody = await complaintsResponse.json() as { complaints?: EncounterComplaint[]; error?: string };
    if (!definitionResponse.ok) throw new Error(definitionBody.error ?? `HPI definition failed: ${definitionResponse.status}`);
    if (!catalogResponse.ok) throw new Error(catalogBody.error ?? `Complaint definitions failed: ${catalogResponse.status}`);
    if (!complaintsResponse.ok) throw new Error(complaintsBody.error ?? `Presenting complaints failed: ${complaintsResponse.status}`);
    const loadedRos = definitionBody.definition?.fields?.reviewOfSystems?.options
      ?.filter((option) => option.active !== false && (option.category === "eye" || option.category === "general"))
      .map(({ code, display, category }) => ({ code, display, category }));
    if (loadedRos?.length) setRosOptions(loadedRos);
    setDefinitions(catalogBody.definitions ?? []);
    setGenericOptions(catalogBody.genericOptions ?? EMPTY_GENERIC_OPTIONS);
    setComplaints(complaintsBody.complaints ?? []);
  }

  function beginDefinition(definition: ComplaintDefinition) {
    setDraft(blankComplaintDraft({ complaintKey: definition.stableKey }));
    setEditingId(null);
    setOverrideDirty(false);
  }

  function beginOther(label = "") {
    setDraft(blankComplaintDraft({ freeTextLabel: label }));
    setEditingId(null);
    setOverrideDirty(false);
  }

  function editComplaint(complaint: EncounterComplaint) {
    const { id, encounterId: _encounterId, patientId: _patientId, ordinal: _ordinal, status: _status, renderedNarrative: _rendered, ...fields } = complaint;
    setDraft(fields);
    setEditingId(id.startsWith("legacy-") ? null : id);
    setOverrideDirty(false);
  }

  function updateDraft(patch: Partial<ComplaintDraft>, codedChange = true) {
    setDraft((current) => current ? { ...current, ...patch } : current);
    if (codedChange && draft?.narrative.mode === "override") setOverrideDirty(true);
  }

  function toggleCode(field: "conditions" | "qualities" | "treatmentsTried", code: string) {
    if (!draft) return;
    const current = draft[field];
    updateDraft({ [field]: current.includes(code) ? current.filter((item) => item !== code) : [...current, code] });
  }

  function setNarrativeMode(mode: "automated" | "override") {
    if (!draft) return;
    updateDraft({
      narrative: mode === "override" ? { mode, overrideText: renderComplaintNarrative({ ...draft, narrative: { mode: "automated" } }, selectedDefinition, genericOptions) } : { mode },
    }, false);
    setOverrideDirty(false);
  }

  async function saveComplaint(addAnother: boolean) {
    if (!draft || (!draft.complaintKey && !draft.freeTextLabel?.trim())) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/complaints`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(editingId
          ? { action: "update", complaintId: editingId, complaint: draft }
          : { action: "create", patientReference, complaint: draft }),
      });
      const body = await response.json() as { complaints?: EncounterComplaint[]; error?: string };
      if (!response.ok || !body.complaints) throw new Error(body.error ?? `Complaint save failed: ${response.status}`);
      const status = complaintSectionStatus(body.complaints);
      setComplaints(body.complaints);
      setDraft(null);
      setEditingId(null);
      setOverrideDirty(false);
      const pending = { status, addAnother };
      setPendingHistoryCapture(pending);
      try {
        await captureHistory();
        finishComplaintCapture(pending);
      } catch (caught) {
        reportComplaintCaptureFailure(pending);
        setSaved(null);
        const detail = caught instanceof Error ? caught.message : String(caught);
        setError(`The complaint was saved, but History was not recorded on the chart. Retry recording History. ${detail}`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function removeComplaint(id: string) {
    await mutateComplaints({ action: "remove", complaintId: id });
  }

  async function reorderComplaints(targetId: string) {
    if (!draggedId || draggedId === targetId) return;
    const ids = complaints.map((complaint) => complaint.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    setDraggedId(null);
    await mutateComplaints({ action: "reorder", complaintIds: ids });
  }

  async function mutateComplaints(body: unknown) {
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/complaints`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { complaints?: EncounterComplaint[]; error?: string };
      if (!response.ok || !result.complaints) throw new Error(result.error ?? `Complaint update failed: ${response.status}`);
      setComplaints(result.complaints);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function addMedicalFlag() {
    const display = newMedicalFlag.trim();
    if (!display) return;
    setError(null);
    const codeBase = `custom-${slug(display) || "medical-flag"}`;
    let code = codeBase;
    let suffix = 2;
    while (rosOptions.some((option) => option.code === code)) code = `${codeBase}-${suffix++}`;
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/finding-definitions/hpi_ros`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add-field-option", fieldKey: "reviewOfSystems", code, display, category: "general" }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok && response.status !== 403) throw new Error(body.error ?? `Review flag save failed: ${response.status}`);
      setRosOptions((current) => [...current, { code, display, category: "general" }]);
      setNewMedicalFlag("");
      setCatalogMessage(response.ok ? "Flag added to the practice Review of Systems catalog." : "Flag added for this encounter only; the catalog write grant is required to reuse it.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function markRemainingNegative(category: RosCategory) {
    setRosStatuses((current) => markRemainingReviewedNegative(current, rosOptions, category));
    setReviewAttestations((current) => current.includes(category) ? current : [...current, category]);
  }

  function promoteToComplaint(option: HpiRosOption) {
    const match = complaintDefinitionForRos(option, definitions);
    if (match) beginDefinition(match);
    else beginOther(option.display);
  }

  async function saveHistory() {
    if (!complaints.length) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      await captureHistory();
      if (pendingHistoryCapture) {
        finishComplaintCapture(pendingHistoryCapture);
      } else {
        setSaved("Reviewed ROS saved to the encounter.");
        onSaved(complaintSectionStatus(complaints, "ODOS UI History / ROS"), false);
      }
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      if (pendingHistoryCapture) reportComplaintCaptureFailure(pendingHistoryCapture);
      setError(pendingHistoryCapture
        ? `The complaint was saved, but History was not recorded on the chart. Retry recording History. ${detail}`
        : detail);
    } finally {
      setSaving(false);
    }
  }

  async function captureHistory(): Promise<void> {
    const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/hpi`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(buildHpiRequestBody({ patientReference, encounterReference, rosStatuses, rosOptions, reviewAttestations })),
    });
    const body = await response.json() as { observationReference?: string; error?: string };
    if (!response.ok || !body.observationReference) throw new Error(body.error ?? `History save failed: ${response.status}`);
  }

  function finishComplaintCapture(pending: PendingHistoryCapture) {
    setPendingHistoryCapture(null);
    setError(null);
    setSaved("Presenting complaint saved. History recorded on the chart.");
    onSaved(pending.status, pending.addAnother);
    pendingNextConcernFocus.current = pending.addAnother;
    setDraft(pending.addAnother ? blankComplaintDraft() : null);
  }

  function reportComplaintCaptureFailure(pending: PendingHistoryCapture) {
    onSaved({ ...pending.status, completed: false }, true);
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <h2 className="odos-hpi-text text-lg font-semibold">Chief complaint / HPI / ROS</h2>
        <p className="odos-hpi-muted mt-1 text-sm">Each saved presenting complaint records History on the chart. Save reviewed ROS after assessing it.</p>

        <div className="odos-hpi-border mt-6 rounded border bg-bg-panel/70 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="odos-hpi-muted text-sm font-semibold uppercase tracking-wider">Presenting Complaints</h3>
              <p className="odos-hpi-faint mt-1 text-xs">The first complaint is primary and leads the History Narrative.</p>
            </div>
          </div>
          {complaints.length === 0 && <p className="odos-hpi-muted mt-4 text-sm">No presenting complaints recorded.</p>}
          <div className="mt-4 space-y-3">
            {complaints.map((complaint) => (
              <article
                key={complaint.id}
                draggable={!complaint.id.startsWith("legacy-")}
                onDragStart={() => setDraggedId(complaint.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => void reorderComplaints(complaint.id)}
                className="odos-hpi-border rounded border bg-bg-deep/60 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="odos-hpi-text flex items-center gap-2 text-sm font-semibold">
                      <span>{complaint.ordinal}. {complaint.freeTextLabel ?? definitions.find((row) => row.stableKey === complaint.complaintKey)?.display ?? "Complaint"}</span>
                      {complaint.ordinal === 1 && <span className="rounded bg-brand/20 px-2 py-0.5 text-[11px] text-brand-light">Primary</span>}
                    </div>
                    <p className="odos-hpi-muted mt-2 text-sm leading-6">{complaint.renderedNarrative}</p>
                    <p className="odos-hpi-faint mt-2 text-xs">HPI: {hpiElementCount(complaint)} elements · Drag to reorder</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="sidebar-button" onClick={() => editComplaint(complaint)}>Edit</button>
                    {!complaint.id.startsWith("legacy-") && <button type="button" className="sidebar-button" onClick={() => void removeComplaint(complaint.id)}>Remove</button>}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>

        {draft ? (
          <ComplaintIntake
            draft={draft}
            definition={selectedDefinition}
            options={options}
            preview={preview}
            overrideDirty={overrideDirty}
            saving={saving}
            presentingConcernRef={presentingConcernRef}
            onUpdate={updateDraft}
            onToggle={toggleCode}
            onNarrativeMode={setNarrativeMode}
            onRegenerate={() => setNarrativeMode("automated")}
            onCancel={() => { setDraft(null); setEditingId(null); setOverrideDirty(false); }}
            onSave={(addAnother) => void saveComplaint(addAnother)}
          />
        ) : (
          <div className="odos-hpi-border mt-5 rounded border bg-bg-panel/70 p-5">
            <h3 className="odos-hpi-muted text-sm font-semibold uppercase tracking-wider">Top Complaints</h3>
            <div className="mt-4">
              <OdosSearchPicker
                label="Search complaints"
                value=""
                placeholder="Complaint name"
                search={searchComplaintOptions}
                onClear={() => undefined}
                onSelect={(option) => beginDefinition(option.item)}
              />
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {topDefinitions.map((definition) => (
                <button key={definition.stableKey} type="button" className="odos-hpi-border odos-hpi-muted rounded border p-3 text-left text-sm hover:border-brand/50 hover:bg-brand/10" onClick={() => beginDefinition(definition)}>
                  {definition.display}
                </button>
              ))}
              <button type="button" className="odos-hpi-border-strong odos-hpi-muted rounded border border-dashed p-3 text-left text-sm hover:border-brand/50" onClick={() => beginOther()}>Other</button>
            </div>
          </div>
        )}

        <div className="odos-hpi-border mt-5 rounded border bg-bg-panel/70 p-5">
          <h3 className="odos-hpi-muted text-sm font-semibold uppercase tracking-wider">Review of Systems</h3>
          <p className="odos-hpi-faint mt-1 text-xs">Leave an item Not reviewed unless it was explicitly assessed.</p>
          {(["eye", "general"] as const).map((category) => (
            <div key={category} className="mt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="odos-hpi-muted text-sm font-semibold">{category === "eye" ? "Eye-focused" : "General medical"}</h4>
                <button type="button" className="sidebar-button" onClick={() => markRemainingNegative(category)}>Mark remaining reviewed: negative</button>
              </div>
              <p className="mt-1 text-xs text-amber-100/70">This attests that every remaining item in this group was reviewed.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {rosOptions.filter((option) => option.category === category).map((option) => (
                  <div key={option.code} className="odos-hpi-muted text-sm">
                    <label>
                      {option.display}
                      <select
                        aria-label={`${option.display} review status`}
                        className="sidebar-input mt-1"
                        value={rosStatuses[option.code] ?? ""}
                        onChange={(event) => setRosStatuses((current) => ({ ...current, [option.code]: event.target.value as RosStatus }))}
                      >
                        <option value="">Not reviewed</option>
                        <option value="negative">Negative</option>
                        <option value="positive">Positive</option>
                      </select>
                    </label>
                    {rosStatuses[option.code] === "positive" && <button type="button" className="mt-2 text-xs text-brand-light underline" onClick={() => promoteToComplaint(option)}>Add as complaint</button>}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="mt-5 flex max-w-xl gap-2">
            <input aria-label="New general-medical review flag" className="sidebar-input" maxLength={120} value={newMedicalFlag} onChange={(event) => setNewMedicalFlag(event.target.value)} placeholder="Add another medical flag" />
            <button type="button" className="sidebar-button shrink-0" disabled={!newMedicalFlag.trim()} onClick={() => void addMedicalFlag()}>Add flag</button>
          </div>
          {catalogMessage && <p className="odos-hpi-muted mt-2 text-xs">{catalogMessage}</p>}
        </div>

        {error && <div role="alert" className="mt-4 rounded border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-100">{error}</div>}
        {saved && <div role="status" className="mt-4 rounded border border-emerald-400/40 bg-emerald-400/10 p-3 text-sm text-emerald-100">{saved}</div>}
        <button type="button" className="sidebar-button mt-5" disabled={saving || complaints.length === 0} onClick={() => void saveHistory()}>
          {saving ? "Saving…" : pendingHistoryCapture ? "Retry recording History" : "Save reviewed ROS"}
        </button>
      </div>
    </section>
  );
}

function complaintSectionStatus(
  complaints: EncounterComplaint[],
  operator = "ODOS UI Complaint Intake",
): SectionSaveStatus {
  return {
    completed: complaints.length > 0,
    summary: complaints.map((complaint) => complaint.renderedNarrative).join(" "),
    savedAt: new Date().toISOString(),
    operator,
  };
}

export function ComplaintIntake(props: {
  draft: ComplaintDraft;
  definition: ComplaintDefinition | undefined;
  options: GenericComplaintOptions;
  preview: string;
  overrideDirty: boolean;
  saving: boolean;
  presentingConcernRef: Ref<HTMLInputElement>;
  onUpdate: (patch: Partial<ComplaintDraft>, codedChange?: boolean) => void;
  onToggle: (field: "conditions" | "qualities" | "treatmentsTried", code: string) => void;
  onNarrativeMode: (mode: "automated" | "override") => void;
  onRegenerate: () => void;
  onCancel: () => void;
  onSave: (addAnother: boolean) => void;
}) {
  const symptom = props.definition?.kind !== "evaluation-reason";
  return (
    <div className="mt-5 rounded border border-brand/30 bg-bg-panel/80 p-5">
      <h3 className="odos-hpi-text text-base font-semibold">Complaint Intake</h3>
      <p className="odos-hpi-muted mt-1 text-sm">{props.definition?.display ?? "Other presenting complaint"}</p>
      {!props.draft.complaintKey && <label className="odos-hpi-muted mt-5 block text-sm">Presenting concern<input autoFocus ref={props.presentingConcernRef} className="sidebar-input mt-2" maxLength={4000} value={props.draft.freeTextLabel ?? ""} onChange={(event) => props.onUpdate({ freeTextLabel: event.target.value })} /></label>}

      {symptom && <IntakeCluster title="Symptoms"><OptionButtons options={props.options.conditions} selected={props.draft.conditions} onToggle={(code) => props.onToggle("conditions", code)} /></IntakeCluster>}
      <IntakeCluster title="Laterality">
        <OptionButtons options={[
          { code: "OD", display: "Right eye", active: true }, { code: "OS", display: "Left eye", active: true },
          { code: "OU", display: "Both eyes", active: true }, { code: "not-applicable", display: "Not applicable", active: true },
        ]} selected={[props.draft.eyeLocation]} onToggle={(code) => props.onUpdate({ eyeLocation: code as ComplaintDraft["eyeLocation"], ...(code !== "OU" ? { eyeComparison: undefined, eyeComparisonOtherText: undefined } : {}) })} />
        {props.draft.eyeLocation === "OU" && <div className="mt-3"><OptionButtons options={[
          { code: "left-worse", display: "Left worse", active: true }, { code: "equal", display: "Equal", active: true },
          { code: "right-worse", display: "Right worse", active: true }, { code: "other", display: "Other comparison", active: true },
        ]} selected={props.draft.eyeComparison ? [props.draft.eyeComparison] : []} onToggle={(code) => props.onUpdate({ eyeComparison: code as ComplaintDraft["eyeComparison"] })} /></div>}
        {props.draft.eyeComparison === "other" && <input aria-label="Other eye comparison" className="sidebar-input mt-3" value={props.draft.eyeComparisonOtherText ?? ""} onChange={(event) => props.onUpdate({ eyeComparisonOtherText: event.target.value })} />}
      </IntakeCluster>
      {symptom && <IntakeCluster title="Character">
        <OptionButtons options={props.options.qualities} selected={props.draft.qualities} onToggle={(code) => props.onToggle("qualities", code)} />
        <label className="odos-hpi-muted mt-3 block max-w-xs text-sm">Severity<select className="sidebar-input mt-2" value={props.draft.severity ?? ""} onChange={(event) => props.onUpdate({ severity: (event.target.value || undefined) as ComplaintDraft["severity"] })}><option value="">Not recorded</option><option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option></select></label>
      </IntakeCluster>}
      <IntakeCluster title="Duration">
        <div className="flex max-w-md gap-2">
          <input aria-label="Duration value" className="sidebar-input" type="number" min={1} value={props.draft.duration?.value ?? ""} onChange={(event) => props.onUpdate({ duration: event.target.value ? { value: Number(event.target.value), unit: props.draft.duration?.unit ?? "days" } : undefined })} />
          <select aria-label="Duration unit" className="sidebar-input" value={props.draft.duration?.unit ?? "days"} onChange={(event) => props.onUpdate({ duration: { value: props.draft.duration?.value ?? 1, unit: event.target.value as NonNullable<ComplaintDraft["duration"]>["unit"] } })}><option value="days">Days</option><option value="weeks">Weeks</option><option value="months">Months</option><option value="years">Years</option></select>
        </div>
      </IntakeCluster>
      <IntakeCluster title="Current treatment"><OptionButtons options={props.options.treatments} selected={props.draft.treatmentsTried} onToggle={(code) => props.onToggle("treatmentsTried", code)} /></IntakeCluster>
      <IntakeCluster title="Referral & history">
        <label className="odos-hpi-muted block text-sm">Referring physician<input className="sidebar-input mt-2" maxLength={500} value={props.draft.referringPhysicianName ?? ""} onChange={(event) => props.onUpdate({ referringPhysicianName: event.target.value })} /></label>
        <label className="odos-hpi-muted mt-3 block text-sm">Additional history<textarea className="sidebar-input mt-2 min-h-24 resize-y" maxLength={4000} value={props.draft.additionalHistory} onChange={(event) => props.onUpdate({ additionalHistory: event.target.value })} /></label>
      </IntakeCluster>
      <div className="odos-hpi-border mt-5 rounded border bg-bg-deep/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="odos-hpi-muted text-sm font-semibold">History Narrative</h4><div className="flex gap-2"><button type="button" className={props.draft.narrative.mode === "automated" ? "sidebar-button border-brand" : "sidebar-button"} onClick={() => props.onNarrativeMode("automated")}>Automated</button><button type="button" className={props.draft.narrative.mode === "override" ? "sidebar-button border-brand" : "sidebar-button"} onClick={() => props.onNarrativeMode("override")}>Override</button></div></div>
        {props.draft.narrative.mode === "override" ? <textarea aria-label="History Narrative override" className="sidebar-input mt-3 min-h-28 resize-y" value={props.draft.narrative.overrideText ?? ""} onChange={(event) => props.onUpdate({ narrative: { mode: "override", overrideText: event.target.value } }, false)} /> : <p className="odos-hpi-muted mt-3 text-sm leading-6">{props.preview}</p>}
        {props.overrideDirty && <div className="mt-3 text-xs text-amber-100">Narrative is overridden and coded fields changed. <button type="button" className="underline" onClick={props.onRegenerate}>Regenerate from coded fields</button></div>}
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" className="sidebar-button" onClick={props.onCancel}>Cancel</button><button type="button" className="sidebar-button" disabled={props.saving || (!props.draft.complaintKey && !props.draft.freeTextLabel?.trim())} onClick={() => props.onSave(true)}>Save and Add Another</button><button type="button" className="sidebar-button" disabled={props.saving || (!props.draft.complaintKey && !props.draft.freeTextLabel?.trim())} onClick={() => props.onSave(false)}>Save Complaint</button></div>
    </div>
  );
}

function IntakeCluster({ title, children }: { title: string; children: React.ReactNode }) {
  return <fieldset className="odos-hpi-border mt-5 rounded border p-4"><legend className="odos-hpi-muted px-2 text-sm font-semibold">{title}</legend>{children}</fieldset>;
}

function OptionButtons({ options, selected, onToggle }: { options: ComplaintOption[]; selected: string[]; onToggle: (code: string) => void }) {
  return <div className="flex flex-wrap gap-2">{options.map((option) => <button key={option.code} type="button" aria-pressed={selected.includes(option.code)} className={selected.includes(option.code) ? "rounded border border-brand bg-brand/20 px-3 py-2 text-sm text-brand-light" : "odos-hpi-border-strong odos-hpi-muted rounded border px-3 py-2 text-sm hover:border-brand/50"} onClick={() => onToggle(option.code)}>{option.display}</button>)}</div>;
}

export function buildHpiRequestBody(input: {
  patientReference: string;
  encounterReference: string;
  rosStatuses: Record<string, RosStatus>;
  rosOptions: HpiRosOption[];
  reviewAttestations: RosCategory[];
}) {
  return {
    patientReference: input.patientReference,
    encounterReference: input.encounterReference,
    reviewOfSystems: input.rosOptions.flatMap((option) => {
      const status = input.rosStatuses[option.code];
      return status === "positive" || status === "negative" ? [{ ...option, status }] : [];
    }),
    reviewAttestations: input.reviewAttestations,
  };
}

export function markRemainingReviewedNegative(
  statuses: Record<string, RosStatus>,
  options: HpiRosOption[],
  category: RosCategory,
): Record<string, RosStatus> {
  return options.filter((option) => option.category === category).reduce((next, option) => ({
    ...next,
    [option.code]: next[option.code] || "negative",
  }), { ...statuses });
}

export function complaintDefinitionForRos(
  option: HpiRosOption,
  definitions: ComplaintDefinition[],
): ComplaintDefinition | undefined {
  const aliases: Record<string, string> = {
    "eye-pain": "patient-eye-pain",
    redness: "patient-red-eye",
    "floaters-flashes": "patient-floaters",
    "vision-changes": "patient-blurred-vision",
  };
  const stableKey = aliases[option.code];
  return definitions.find((definition) => definition.stableKey === stableKey && definition.status === "active");
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 68);
}
