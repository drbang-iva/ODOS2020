import type { ClinicalGraphProvenance } from "./glaucoma-suspect.js";
import {
  renderDeclaredComplaintNarrative,
  type HistoryTemplate,
  type HistoryTemplateAnswer,
} from "./history-template-engine.js";

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
  narrativeTemplate?: string;
  seedRank: number;
  sourceStatus: "seed" | "local-practice";
  status: "active" | "retired";
  provenance: ClinicalGraphProvenance;
}

export interface EncounterComplaint {
  id: string;
  encounterId: string;
  patientId: string;
  ordinal: number;
  templateKey?: string;
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
  referringPhysicianRef?: string;
  referringPhysicianName?: string;
  additionalHistory: string;
  narrative: {
    mode: "automated" | "override";
    overrideText?: string;
    overrideProvenance?: ClinicalGraphProvenance;
  };
  resolvedDx: string[];
  status: "active" | "removed";
  provenance: ClinicalGraphProvenance;
  provenanceHistory: ClinicalGraphProvenance[];
}

export const COMPLAINT_SEED_PROVENANCE_NOTE =
  "Seeded from the 2026-07-20 Eyefinity walkthrough transcription. The captured Condition and Quality lists ended in ellipses and are intentionally partial; no omitted vocabulary is inferred.";

const SEED_PROVENANCE: ClinicalGraphProvenance = {
  source: "manual",
  recordedAt: new Date(0).toISOString(),
  actorReference: "Practitioner/odos-system",
  note: COMPLAINT_SEED_PROVENANCE_NOTE,
};

function options(rows: Array<[string, string]>): ComplaintOption[] {
  return rows.map(([code, display]) => ({ code, display, active: true }));
}

export const GENERIC_COMPLAINT_CONDITIONS = options([
  ["blurred-vision", "Blurred Vision"],
  ["brown-spot-on-eye", "Brown Spot on Eye"],
  ["bulging-eye", "Bulging Eye"],
  ["cloudy-vision", "Cloudy Vision"],
  ["difficulty-driving", "Difficulty Driving"],
  ["difficulty-reading", "Difficulty Reading"],
  ["difficulty-seeing-street-signs", "Difficulty Seeing Street Signs"],
  ["difficulty-seeing-tv", "Difficulty Seeing TV"],
  ["difficulty-using-computers", "Difficulty Using Computers"],
  ["distorted-vision", "Distorted Vision"],
  ["double-vision", "Double Vision"],
  ["droopy-eyelids", "Droopy Eyelids"],
  ["dry-eyes", "Dry Eyes"],
]);

export const GENERIC_COMPLAINT_QUALITIES = options([
  ["activity-dependent", "activity dependent"],
  ["asymptomatic", "asymptomatic"],
  ["central", "central"],
  ["constant", "constant"],
  ["horizontal", "horizontal"],
  ["intermittent", "intermittent"],
  ["new", "new"],
  ["occurs-when-driving", "occurs when driving"],
  ["occurs-when-reading", "occurs when reading"],
  ["peripheral", "peripheral"],
  ["progressive", "progressive"],
]);

export const GENERIC_COMPLAINT_TREATMENTS = options([
  ["anti-allergy-drops", "anti-allergy drops"],
  ["antibiotic-drops", "antibiotic drops"],
  ["antibiotic-ointment", "antibiotic ointment"],
  ["antibiotic-oral", "antibiotic oral"],
  ["antihistamines", "antihistamines"],
  ["cold-compresses", "cold compresses"],
  ["no-treatment", "no treatment"],
  ["steroid-drops", "steroid drops"],
  ["steroid-oral", "steroid oral"],
]);

const DRY_EYE_QUALITIES = options([
  ["environmentally-sensitive", "environmentally sensitive"],
  ["brought-on-by-drafts-or-fans", "brought on by drafts or fans"],
]);

const DRY_EYE_TREATMENTS = options([
  ["artificial-tears", "artificial tears"],
  ["autologous-serum", "autologous serum"],
  ["lid-hygiene", "lid hygiene"],
  ["warm-compresses", "warm compresses"],
]);

const COMPLAINT_SEED_ROWS: Array<[string, string, ComplaintDefinition["kind"]]> = [
  ["patient-blurred-vision", "Patient (Blurred Vision)", "patient-symptom"],
  ["contact-lens-evaluation", "Contact Lens Evaluation", "evaluation-reason"],
  ["routine-eye-exam", "Routine Eye Exam", "evaluation-reason"],
  ["patient-decreased-vision", "Patient (Decreased Vision)", "patient-symptom"],
  ["diabetic-ocular-evaluation", "Diabetic Ocular Evaluation", "evaluation-reason"],
  ["patient-eye-irritation", "Patient (Eye Irritation)", "patient-symptom"],
  ["patient-red-eye", "Patient (Red Eye)", "patient-symptom"],
  ["postop-cataract", "Postop Cataract", "evaluation-reason"],
  ["patient-eye-pain", "Patient (Eye Pain)", "patient-symptom"],
  ["dry-eye", "Patient (Dry Eye)", "patient-symptom"],
  ["patient-floaters", "Patient (Floaters)", "patient-symptom"],
  ["patient-foreign-body-sensation", "Patient (Foreign Body Sensation)", "patient-symptom"],
  ["glaucoma", "Glaucoma", "evaluation-reason"],
];

export function buildComplaintDefinitionSeeds(): ComplaintDefinition[] {
  return COMPLAINT_SEED_ROWS.map(([stableKey, display, kind], index) => ({
    id: `complaint-definition-${stableKey}`,
    stableKey,
    display,
    kind,
    conditionOptions: [],
    qualityOptions: stableKey === "dry-eye" ? DRY_EYE_QUALITIES : [],
    treatmentOptions: stableKey === "dry-eye" ? DRY_EYE_TREATMENTS : [],
    seedRank: index + 1,
    sourceStatus: "seed",
    status: "active",
    provenance: SEED_PROVENANCE,
  }));
}

export function effectiveComplaintOptions(
  definition: ComplaintDefinition | undefined,
): { conditions: ComplaintOption[]; qualities: ComplaintOption[]; treatments: ComplaintOption[] } {
  return {
    conditions: mergeOptions(GENERIC_COMPLAINT_CONDITIONS, definition?.conditionOptions ?? []),
    qualities: mergeOptions(GENERIC_COMPLAINT_QUALITIES, definition?.qualityOptions ?? []),
    treatments: mergeOptions(GENERIC_COMPLAINT_TREATMENTS, definition?.treatmentOptions ?? []),
  };
}

export function renderComplaintNarrative(
  complaint: Pick<EncounterComplaint,
    "complaintKey" | "freeTextLabel" | "conditions" | "eyeLocation" | "eyeComparison" |
    "eyeComparisonOtherText" | "qualities" | "severity" | "duration" | "treatmentsTried" |
    "referringPhysicianName" | "referringPhysicianRef" | "additionalHistory" | "narrative"
  >,
  definition: ComplaintDefinition | undefined,
  declared?: { template: HistoryTemplate; answers: HistoryTemplateAnswer[] },
): string {
  if (declared) return renderDeclaredComplaintNarrative(declared.template, declared.answers);
  if (complaint.narrative.mode === "override" && complaint.narrative.overrideText?.trim()) {
    return complaint.narrative.overrideText.trim();
  }
  const effective = effectiveComplaintOptions(definition);
  const conditions = displays(complaint.conditions, effective.conditions).map((display) => display.toLowerCase());
  const reported = conditions.length
    ? conditions.join(", ")
    : complaint.freeTextLabel?.trim() || cleanComplaintDisplay(definition?.display) || "the presenting concern";
  let first = `Patient reports ${reported}`;
  const laterality = lateralityPhrase(complaint.eyeLocation);
  if (laterality) first += `, ${laterality}`;
  const comparison = comparisonPhrase(complaint.eyeComparison, complaint.eyeComparisonOtherText);
  if (comparison) first += `, ${comparison}`;
  if (complaint.duration) first += `, ongoing for ${durationPhrase(complaint.duration)}`;
  first += ".";

  const qualities = displays(complaint.qualities, effective.qualities);
  const described = qualities.length || complaint.severity
    ? ` Described as ${[...qualities, complaint.severity].filter(Boolean).join(", ")}.`
    : "";
  const treatments = displays(complaint.treatmentsTried, effective.treatments);
  const treatment = ` Current treatment: ${treatments.length ? treatments.join(", ") : "none"}.`;
  const referralName = complaint.referringPhysicianName?.trim() || complaint.referringPhysicianRef;
  const referral = referralName ? ` Referred by ${referralName}.` : "";
  const additional = complaint.additionalHistory.trim()
    ? ` Additional history: ${sentenceText(complaint.additionalHistory)}.`
    : "";
  return `${first}${described}${treatment}${referral}${additional}`;
}

export function complaintReasonText(complaint: EncounterComplaint, definition: ComplaintDefinition | undefined): string {
  const display = complaint.freeTextLabel?.trim() || cleanComplaintDisplay(definition?.display) || "Presenting concern";
  const laterality = lateralityPhrase(complaint.eyeLocation);
  const duration = complaint.duration ? durationPhrase(complaint.duration) : undefined;
  return [display, laterality, duration].filter(Boolean).join(", ");
}

function mergeOptions(generic: ComplaintOption[], additions: ComplaintOption[]): ComplaintOption[] {
  const merged = new Map(generic.map((option) => [option.code, option]));
  for (const option of additions) merged.set(option.code, option);
  return [...merged.values()].filter((option) => option.active);
}

function displays(codes: string[], options: ComplaintOption[]): string[] {
  const byCode = new Map(options.map((option) => [option.code, option.display]));
  return codes.flatMap((code) => byCode.get(code) ? [byCode.get(code)!] : []);
}

function lateralityPhrase(value: EncounterComplaint["eyeLocation"]): string | undefined {
  return value === "OD" ? "right eye" : value === "OS" ? "left eye" : value === "OU" ? "both eyes" : undefined;
}

function comparisonPhrase(
  value: EncounterComplaint["eyeComparison"],
  otherText: string | undefined,
): string | undefined {
  if (value === "left-worse") return "left worse than right";
  if (value === "right-worse") return "right worse than left";
  if (value === "equal") return "equal between eyes";
  if (value === "other") return otherText?.trim() || "other comparison";
  return undefined;
}

function cleanComplaintDisplay(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const patient = value.match(/^Patient \((.+)\)$/);
  return (patient?.[1] ?? value).toLowerCase();
}

function sentenceText(value: string): string {
  return value.trim().replace(/[.!?]+$/, "");
}

function durationPhrase(duration: NonNullable<EncounterComplaint["duration"]>): string {
  const unit = duration.value === 1 ? duration.unit.replace(/s$/, "") : duration.unit;
  return `${duration.value} ${unit}`;
}
