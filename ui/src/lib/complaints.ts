export interface ComplaintOption {
  code: string;
  display: string;
  active: boolean;
}

export interface ComplaintDefinition {
  id: string;
  stableKey: string;
  display: string;
  kind: "patient-symptom" | "evaluation-reason";
  conditionOptions: ComplaintOption[];
  qualityOptions: ComplaintOption[];
  treatmentOptions: ComplaintOption[];
  seedRank: number;
  status: "active" | "retired";
}

export interface ComplaintDraft {
  complaintKey?: string;
  freeTextLabel?: string;
  conditions: string[];
  eyeLocation: "OD" | "OS" | "OU" | "not-applicable";
  eyeComparison?: "left-worse" | "equal" | "right-worse" | "other";
  eyeComparisonOtherText?: string;
  qualities: string[];
  severity?: "mild" | "moderate" | "severe";
  duration?: { value: number; unit: "days" | "weeks" | "months" | "years" };
  treatmentsTried: string[];
  referringPhysicianName?: string;
  additionalHistory: string;
  narrative: { mode: "automated" | "override"; overrideText?: string };
}

export interface EncounterComplaint extends ComplaintDraft {
  id: string;
  encounterId: string;
  patientId: string;
  ordinal: number;
  status: "active" | "removed";
  renderedNarrative: string;
}

export interface GenericComplaintOptions {
  conditions: ComplaintOption[];
  qualities: ComplaintOption[];
  treatments: ComplaintOption[];
}

export function blankComplaintDraft(input: { complaintKey?: string; freeTextLabel?: string } = {}): ComplaintDraft {
  return {
    ...input,
    conditions: [],
    eyeLocation: "not-applicable",
    qualities: [],
    treatmentsTried: [],
    additionalHistory: "",
    narrative: { mode: "automated" },
  };
}

export function effectiveComplaintOptions(
  generic: GenericComplaintOptions,
  definition: ComplaintDefinition | undefined,
): GenericComplaintOptions {
  return {
    conditions: merge(generic.conditions, definition?.conditionOptions ?? []),
    qualities: merge(generic.qualities, definition?.qualityOptions ?? []),
    treatments: merge(generic.treatments, definition?.treatmentOptions ?? []),
  };
}

export function renderComplaintNarrative(
  complaint: ComplaintDraft,
  definition: ComplaintDefinition | undefined,
  generic: GenericComplaintOptions,
): string {
  if (complaint.narrative.mode === "override" && complaint.narrative.overrideText?.trim()) {
    return complaint.narrative.overrideText.trim();
  }
  const effective = effectiveComplaintOptions(generic, definition);
  const conditions = displays(complaint.conditions, effective.conditions).map((display) => display.toLowerCase());
  const reported = conditions.length
    ? conditions.join(", ")
    : complaint.freeTextLabel?.trim() || cleanDisplay(definition?.display) || "the presenting concern";
  let first = `Patient reports ${reported}`;
  const laterality = complaint.eyeLocation === "OD" ? "right eye" : complaint.eyeLocation === "OS" ? "left eye" : complaint.eyeLocation === "OU" ? "both eyes" : undefined;
  if (laterality) first += `, ${laterality}`;
  const comparison = complaint.eyeComparison === "left-worse" ? "left worse than right"
    : complaint.eyeComparison === "right-worse" ? "right worse than left"
    : complaint.eyeComparison === "equal" ? "equal between eyes"
    : complaint.eyeComparison === "other" ? complaint.eyeComparisonOtherText?.trim() || "other comparison"
    : undefined;
  if (comparison) first += `, ${comparison}`;
  if (complaint.duration) first += `, ongoing for ${durationPhrase(complaint.duration)}`;
  first += ".";
  const qualities = displays(complaint.qualities, effective.qualities);
  const described = qualities.length || complaint.severity
    ? ` Described as ${[...qualities, complaint.severity].filter(Boolean).join(", ")}.`
    : "";
  const treatments = displays(complaint.treatmentsTried, effective.treatments);
  const treatment = ` Current treatment: ${treatments.length ? treatments.join(", ") : "none"}.`;
  const referral = complaint.referringPhysicianName?.trim() ? ` Referred by ${complaint.referringPhysicianName.trim()}.` : "";
  const additional = complaint.additionalHistory.trim()
    ? ` Additional history: ${complaint.additionalHistory.trim().replace(/[.!?]+$/, "")}.`
    : "";
  return `${first}${described}${treatment}${referral}${additional}`;
}

export function hpiElementCount(complaint: ComplaintDraft): number {
  return [
    complaint.eyeLocation !== "not-applicable",
    complaint.qualities.length > 0,
    Boolean(complaint.severity),
    Boolean(complaint.duration),
    complaint.qualities.some((code) => ["constant", "intermittent", "activity-dependent", "occurs-when-driving", "occurs-when-reading"].includes(code)),
    complaint.qualities.length > 0 || Boolean(complaint.additionalHistory.trim()),
    complaint.treatmentsTried.length > 0,
    complaint.conditions.length > 1,
  ].filter(Boolean).length;
}

function merge(generic: ComplaintOption[], additions: ComplaintOption[]): ComplaintOption[] {
  const merged = new Map(generic.map((option) => [option.code, option]));
  for (const option of additions) merged.set(option.code, option);
  return [...merged.values()].filter((option) => option.active !== false);
}

function displays(codes: string[], options: ComplaintOption[]): string[] {
  const byCode = new Map(options.map((option) => [option.code, option.display]));
  return codes.flatMap((code) => byCode.get(code) ? [byCode.get(code)!] : []);
}

function cleanDisplay(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return (value.match(/^Patient \((.+)\)$/)?.[1] ?? value).toLowerCase();
}

function durationPhrase(duration: NonNullable<ComplaintDraft["duration"]>): string {
  const unit = duration.value === 1 ? duration.unit.replace(/s$/, "") : duration.unit;
  return `${duration.value} ${unit}`;
}
