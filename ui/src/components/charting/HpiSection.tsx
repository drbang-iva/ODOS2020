import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

type RosCategory = "eye" | "general";
type RosStatus = "" | "positive" | "negative";

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

export const HPI_ELEMENTS = [
  ["location", "Location"],
  ["quality", "Quality"],
  ["severity", "Severity"],
  ["duration", "Duration"],
  ["timing", "Timing"],
  ["context", "Context"],
  ["modifyingFactors", "Modifying factors"],
  ["associatedSignsSymptoms", "Associated signs / symptoms"],
] as const;

type HpiElementKey = typeof HPI_ELEMENTS[number][0];

export interface HpiFormState {
  chiefComplaint: string;
  hpi: Record<HpiElementKey, string>;
  rosStatuses: Record<string, RosStatus>;
  rosOptions: HpiRosOption[];
}

const EMPTY_HPI = Object.fromEntries(HPI_ELEMENTS.map(([key]) => [key, ""])) as Record<HpiElementKey, string>;

export function HpiSection({ patientReference, encounterReference, onSaved }: Props) {
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [hpi, setHpi] = useState<Record<HpiElementKey, string>>({ ...EMPTY_HPI });
  const [rosOptions, setRosOptions] = useState<HpiRosOption[]>(DEFAULT_HPI_ROS_OPTIONS);
  const [rosStatuses, setRosStatuses] = useState<Record<string, RosStatus>>({});
  const [newMedicalFlag, setNewMedicalFlag] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    void loadDefinition().catch((caught) => {
      console.error("HPI definition unavailable; using compiled section defaults.", caught);
    });
  }, []);

  async function loadDefinition() {
    const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/hpi/definition`, { headers: authHeaders() });
    const body = await response.json() as {
      definition?: { fields?: { reviewOfSystems?: { options?: Array<HpiRosOption & { active?: boolean }> } } };
      error?: string;
    };
    if (!response.ok) throw new Error(body.error ?? `HPI definition failed: ${response.status}`);
    const options = body.definition?.fields?.reviewOfSystems?.options
      ?.filter((option) => option.active !== false && (option.category === "eye" || option.category === "general"))
      .map(({ code, display, category }) => ({ code, display, category }));
    if (options?.length) setRosOptions(options);
  }

  function addMedicalFlag() {
    const display = newMedicalFlag.trim();
    if (!display) return;
    const codeBase = `custom-${slug(display) || "medical-flag"}`;
    let code = codeBase;
    let suffix = 2;
    while (rosOptions.some((option) => option.code === code)) {
      code = `${codeBase}-${suffix}`;
      suffix += 1;
    }
    setRosOptions((current) => [...current, { code, display, category: "general" }]);
    setNewMedicalFlag("");
  }

  async function save() {
    if (!chiefComplaint.trim()) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/hpi`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(buildHpiRequestBody({
          patientReference,
          encounterReference,
          chiefComplaint,
          hpi,
          rosStatuses,
          rosOptions,
        })),
      });
      const body = await response.json() as { observationReference?: string; error?: string };
      if (!response.ok || !body.observationReference) {
        throw new Error(body.error ?? `HPI save failed: ${response.status}`);
      }
      const summary = chiefComplaint.trim();
      setSaved("History saved to the encounter.");
      onSaved({
        completed: true,
        summary,
        savedAt: new Date().toISOString(),
        operator: "OSOD UI HPI / ROS",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl">
        <div>
          <h2 className="text-lg font-semibold text-white">Chief complaint / HPI / ROS</h2>
          <p className="mt-1 text-sm text-white/45">Document the presenting concern, its history, and reviewed systems without assigning a diagnosis.</p>
        </div>

        <div className="mt-6 rounded border border-white/10 bg-bg-panel/70 p-5">
          <label className="text-sm font-semibold text-white/70">
            Chief complaint
            <textarea
              aria-label="Chief complaint"
              className="sidebar-input mt-2 min-h-24 resize-y"
              maxLength={2000}
              value={chiefComplaint}
              onChange={(event) => setChiefComplaint(event.target.value)}
              placeholder="Patient's reason for today's visit"
            />
          </label>
          <p className="mt-2 text-xs text-white/35">Saved as OSOD-local finding evidence and as free text on the encounter reason.</p>
        </div>

        <div className="mt-5 rounded border border-white/10 bg-bg-panel/70 p-5">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-white/55">History of present illness</h3>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {HPI_ELEMENTS.map(([key, label]) => (
              <label key={key} className="text-sm text-white/65">
                {label}
                <textarea
                  aria-label={label}
                  className="sidebar-input mt-2 min-h-20 resize-y"
                  maxLength={2000}
                  value={hpi[key]}
                  onChange={(event) => setHpi((current) => ({ ...current, [key]: event.target.value }))}
                />
              </label>
            ))}
          </div>
        </div>

        <div className="mt-5 rounded border border-white/10 bg-bg-panel/70 p-5">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-white/55">Review of systems</h3>
          <p className="mt-1 text-xs text-white/35">Leave an item Not reviewed unless it was explicitly assessed.</p>
          {(["eye", "general"] as const).map((category) => (
            <div key={category} className="mt-5">
              <h4 className="text-sm font-semibold text-white/70">{category === "eye" ? "Eye-focused" : "General medical"}</h4>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {rosOptions.filter((option) => option.category === category).map((option) => (
                  <label key={option.code} className="text-sm text-white/60">
                    {option.display}
                    <select
                      aria-label={`${option.display} review status`}
                      className="sidebar-input mt-1"
                      value={rosStatuses[option.code] ?? ""}
                      onChange={(event) => setRosStatuses((current) => ({
                        ...current,
                        [option.code]: event.target.value as RosStatus,
                      }))}
                    >
                      <option value="">Not reviewed</option>
                      <option value="negative">Negative</option>
                      <option value="positive">Positive</option>
                    </select>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="mt-5 flex max-w-xl gap-2">
            <input
              aria-label="New general-medical review flag"
              className="sidebar-input"
              maxLength={120}
              value={newMedicalFlag}
              onChange={(event) => setNewMedicalFlag(event.target.value)}
              placeholder="Add another medical flag"
            />
            <button type="button" className="sidebar-button shrink-0" disabled={!newMedicalFlag.trim()} onClick={addMedicalFlag}>
              Add flag
            </button>
          </div>
        </div>

        {error && <div role="alert" className="mt-4 rounded border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-100">{error}</div>}
        {saved && <div role="status" className="mt-4 rounded border border-emerald-400/40 bg-emerald-400/10 p-3 text-sm text-emerald-100">{saved}</div>}
        <button type="button" className="sidebar-button mt-5" disabled={saving || !chiefComplaint.trim()} onClick={save}>
          {saving ? "Saving…" : "Save history"}
        </button>
      </div>
    </section>
  );
}

export function buildHpiRequestBody(input: HpiFormState & {
  patientReference: string;
  encounterReference: string;
}) {
  return {
    patientReference: input.patientReference,
    encounterReference: input.encounterReference,
    chiefComplaint: input.chiefComplaint.trim(),
    hpi: Object.fromEntries(Object.entries(input.hpi).flatMap(([key, value]) =>
      value.trim() ? [[key, value.trim()]] : []
    )),
    reviewOfSystems: input.rosOptions.flatMap((option) => {
      const status = input.rosStatuses[option.code];
      return status === "positive" || status === "negative"
        ? [{ ...option, status }]
        : [];
    }),
  };
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 68);
}
