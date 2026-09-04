export const HISTORY_SECTION_TYPES = [
  "presentation",
  "symptoms",
  "quality",
  "severity",
  "duration",
  "risk_factors",
  "treatment",
  "numeric",
  "presents_for",
  "interval",
  "laterality",
  "text",
  "single_select",
] as const;

export type HistorySectionType = typeof HISTORY_SECTION_TYPES[number];
export type TriState = "positive" | "negative";
export type HistoryEye = "OD" | "OS" | "OU";

export interface HistoryCatalogOption {
  code: string;
  display: string;
  per_eye?: boolean;
  note_on_positive?: boolean;
}

export const HISTORY_OPTION_CATALOGS: Record<string, HistoryCatalogOption[]> = {
  glaucoma_presentations: options([
    ["follow-up", "Follow Up"],
    ["pressure-check", "Pressure Check"],
    ["elevated-iop", "Elevated IOP"],
    ["glaucoma-evaluation", "Glaucoma Evaluation"],
    ["blurred-vision", "Blurred Vision"],
    ["other", "Other"],
  ]),
  glaucoma_symptoms: optionsFromDisplays([
    "blurred vision", "dry eye", "halos around lights", "headache", "itching", "nausea",
    "no symptoms", "ocular pain", "ocular pain after exercise", "photophobia", "red eye",
    "tearing", "vomiting", "other",
  ]),
  glaucoma_risk: optionsFromDisplays([
    "African American heritage", "anterior chamber IOL", "anti-depressants", "anti-histamines",
    "aphakia", "attack of angle closure glaucoma", "cataract", "cataract extraction with IOL",
    "cold remedies", "family history of glaucoma", "glaucoma", "hyperopia", "IOL exchange",
    "laser gonioplasty", "laser peripheral iridotomy", "laser trabeculoplasty", "ocular trauma",
    "pigment dispersion syndrome", "previous DSAEK", "previous intraocular surgery",
    "previous penetrating keratoplasty", "previous scleral buckle", "pseudoexfoliation syndrome",
    "sleeping pills", "steroid drops", "steroid inhalers", "steroid injections",
    "steroid nasal sprays", "steroids (oral)", "surgical peripheral iridectomy", "trabeculectomy",
    "tube shunt", "uveitis/iritis", "other",
  ]),
  glaucoma_formulary: optionsFromDisplays([
    "Alphagan", "Alphagan-P", "Atropine", "Azopt", "Betimol", "Betoptic", "brimonidine",
    "brinzolamide/brimonidine", "Combigan", "Cosopt", "decadron (subconj)", "Diamox pills",
    "dorzolamide (drops & pills)", "dorzolamide/timolol", "Durezol", "Istalol", "latanoprost",
    "Lotemax", "Lumigan", "methazolamide pills", "Neptazane pills", "no treatment",
    "phospholine iodide", "pilocarpine", "Pred Forte", "prednisolone acetate", "Rhopressa",
    "Rocklatan", "Simbrinza", "steroid drops", "steroids (oral)", "timolol", "Travatan",
    "Travatan-Z", "Trusopt", "Vyzulta", "Xalatan", "Zioptan", "other",
  ]),
  glaucoma_workup: optionsFromDisplays([
    "cataract extraction with IOL", "fundus photos", "further evaluation and management", "gonioscopy",
    "IOL exchange", "IOP check", "laser gonioplasty", "laser peripheral iridotomy",
    "laser trabeculoplasty", "ocular exam", "optic nerve imaging", "surgical peripheral iridectomy",
    "trabeculectomy", "tube shunt", "ultrasonic pachymetry", "visual field testing", "other",
  ]),
  routine_presentations: options([
    ["blurred-vision", "Blurred Vision"],
    ["decreased-vision", "Decreased Vision"],
    ["routine-eye-exam", "Routine Eye Exam"],
    ["contact-lens-evaluation", "Contact Lens Evaluation"],
  ]),
  routine_reasons: optionsFromDisplays([
    "baseline exam", "baseline exam for driver's license", "baseline exam for school sports",
    "blurred vision at a distance", "blurred vision at near", "contact lens prescription",
    "exam for contact lenses", "exam for glasses", "eyeglass check", "eyeglass prescription", "other",
  ]),
  routine_symptoms: optionsFromDisplays([
    "a change in pupil size", "double vision", "drooping lids", "dry eyes", "flashes of light",
    "floaters", "foreign body sensation", "headaches", "irritation", "itchy eyes", "migraines",
    "pain", "photophobia", "red eyes", "swelling in eyelid(s)", "tearing", "visual field defect",
    "wearing contacts", "wearing glasses", "other",
  ]),
  routine_risk: optionsFromDisplays([
    "AMD", "antihistamines", "autoimmune disease", "contact lens usage", "diabetes",
    "dry eye syndrome", "family history of vision loss", "glaucoma", "high myopia", "hypertension",
    "laser vision correction", "MS", "occupational risk/exposure", "plaquenil", "psychiatric meds",
    "recent surgery", "stroke", "thyroid disease", "trauma", "Viagra", "other",
  ]),
  routine_treatment: optionsFromDisplays([
    "artificial tears", "Cequa", "contacts", "eyeglasses", "lid scrubs", "lubricating gel/ointment",
    "no treatment", "punctal plugs", "Restasis", "steroid eye drops", "steroids (oral)", "Xiidra", "other",
  ]),
  ocular_history_conditions: ocularOptions([
    ["dry-eye", "Dry eye", false],
    ["glaucoma", "Glaucoma", true],
    ["cataract", "Cataract", true],
    ["macular-degeneration", "Macular degeneration", true],
    ["amblyopia", "Amblyopia", true],
    ["strabismus", "Strabismus", false],
    ["retinal-disease", "Retinal disease", true],
    ["ocular-trauma", "Ocular trauma", true],
    ["other", "Other ocular condition", true],
  ]),
  ocular_history_surgeries: ocularOptions([
    ["cataract-surgery", "Cataract surgery", true],
    ["laser-vision-correction", "LASIK / PRK", true],
    ["retinal-surgery", "Retinal surgery", true],
    ["glaucoma-surgery", "Glaucoma surgery", true],
    ["corneal-transplant", "Corneal transplant", true],
    ["strabismus-surgery", "Strabismus surgery", false],
    ["other", "Other ocular surgery", true],
  ]),
  medical_history_conditions: options([
    ["anxiety-disorder", "Anxiety disorder"],
    ["depressive-disorder", "Depressive disorder"],
    ["diabetes-mellitus", "Diabetes mellitus"],
    ["hypertension", "Hypertension"],
    ["hypercholesterolemia", "Hypercholesterolemia"],
    ["thyroid-disease", "Thyroid disease"],
  ]),
  medical_history_ophthalmic_medications: options([
    ["miebo-pf", "Miebo (PF)"],
    ["tryptyr", "Tryptyr"],
  ]),
  medical_history_systemic_medications: options([
    ["ibuprofen-800-mg", "ibuprofen 800 mg"],
    ["valtrex-1-g", "Valtrex 1 g"],
  ]),
  medical_history_allergies: options([
    ["no-known-drug-allergies", "No known drug allergies"],
  ]),
  tobacco_status: options([
    ["never", "Never"],
    ["former-smoker", "Former smoker"],
    ["current", "Current"],
  ]),
  social_history_driving: options([
    ["drives-in-daytime", "Drives in daytime"],
    ["drives-at-night", "Drives at night"],
  ]),
  social_history_alcohol_drugs: options([
    ["alcohol-use", "Alcohol use"],
    ["recreational-drugs", "Recreational drugs"],
  ]),
  social_history_home_safety: options([
    ["does-not-feel-safe-at-home", "Does not feel safe at home"],
  ]),
};

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

export const HISTORY_SUBJECT_SECTIONS: HistorySubjectSection[] = [
  {
    key: "ocular-history",
    label: "Ocular History",
    subjectScope: "patient",
    completionAnchor: "conditions",
    sections: [
      section("conditions", "risk_factors", "Conditions", { catalog: "ocular_history_conditions", required: true }),
      section("surgeries", "risk_factors", "Surgeries", { catalog: "ocular_history_surgeries", required: true }),
    ],
  },
  {
    key: "medical-history",
    label: "Medical History",
    subjectScope: "patient",
    completionAnchor: "conditions",
    sections: [
      section("conditions", "risk_factors", "Conditions", { catalog: "medical_history_conditions", required: true }),
      section("ophthalmic-medications", "treatment", "Ophthalmic medications", { catalog: "medical_history_ophthalmic_medications", per_eye: true, required: true }),
      section("systemic-medications", "treatment", "Systemic medications", { catalog: "medical_history_systemic_medications", per_eye: false, required: true }),
      section("allergies", "risk_factors", "Allergies", { catalog: "medical_history_allergies", required: true }),
    ],
  },
  {
    key: "social-history",
    label: "Social History",
    subjectScope: "patient",
    completionAnchor: "tobacco",
    sections: [
      section("tobacco", "single_select", "Tobacco", { catalog: "tobacco_status", required: true }),
      section("driving", "risk_factors", "Driving", { catalog: "social_history_driving", required: true }),
      section("alcohol-drugs", "risk_factors", "Alcohol · Drugs", { catalog: "social_history_alcohol_drugs", required: true }),
      section("occupation", "text", "Occupation"),
      section("home-safety", "risk_factors", "Home safety", { catalog: "social_history_home_safety", required: true }),
    ],
  },
];

export const HISTORY_TEMPLATES: HistoryTemplate[] = [
  {
    complaint: "glaucoma",
    label: "Glaucoma",
    presentations: "glaucoma_presentations",
    sections: [
      section("symptoms", "symptoms", "Signs & symptoms", { catalog: "glaucoma_symptoms", required: true }),
      section("severity", "severity", "Severity"),
      section("symptom-duration", "duration", "these symptoms"),
      section("glaucoma-duration", "duration", "glaucoma"),
      section("risk-factors", "risk_factors", "Risk factors", { catalog: "glaucoma_risk", required: true }),
      section("past-treatment", "treatment", "Past glaucoma treatment", { catalog: "glaucoma_formulary", when: "past", per_eye: false }),
      section("current-treatment", "treatment", "Current glaucoma treatment", { catalog: "glaucoma_formulary", when: "current", per_eye: true, required: true }),
      section("interval", "interval", "Since the last visit", { on: "follow-up" }),
      section("presents-for", "presents_for", "Today the patient presents for", { catalog: "glaucoma_workup", prefill: "last_plan", required: true }),
      section("referred-by", "text", "Who referred the patient?"),
      section("additional-history", "text", "Additional history"),
    ],
    narrative: "is being seen for {presentation}. {symptoms|Reports|Denies}. Currently on {treatment.current|per_eye}. {risk_factors.positive|Risk factors:}. {interval}. Today: {presents_for}.",
  },
  {
    complaint: "routine",
    label: "Routine / New Visit",
    presentations: "routine_presentations",
    sections: [
      section("presents-for", "presents_for", "What brings the patient in?", { catalog: "routine_reasons", required: true }),
      section("symptoms", "symptoms", "Signs & symptoms", { catalog: "routine_symptoms", required: true }),
      section("severity", "severity", "Severity"),
      section("duration", "duration", "these symptoms"),
      section("risk-factors", "risk_factors", "Context", { catalog: "routine_risk", required: true }),
      section("current-treatment", "treatment", "Current treatment", { catalog: "routine_treatment", when: "current", per_eye: true, required: true }),
      section("laterality", "laterality", "Laterality comparison"),
      section("referred-by", "text", "Who referred the patient?"),
      section("additional-history", "text", "Additional history"),
    ],
    narrative: "is being seen for {presentation}. {symptoms|Reports|Denies}. Current treatment: {treatment.current|per_eye}. {risk_factors.positive|Context:}. Today: {presents_for}.",
  },
];

export type HistoryTemplateValue =
  | { kind: "tri-state"; status: TriState; note?: string }
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
  eye?: HistoryEye;
  observationReference?: string;
  value: HistoryTemplateValue;
}

export type HistoryTemplateAnswer = HistoryTemplateAnswerBase & (
  | { complaintId: string; subjectScope?: never }
  | { complaintId?: never; subjectScope: "encounter" | "patient" }
);

export function cycleTriState(value: TriState | undefined): TriState | undefined {
  return value === undefined ? "positive" : value === "positive" ? "negative" : undefined;
}

export function activeTemplateSections(template: HistoryTemplate, presentation: string | undefined): HistoryTemplateSection[] {
  return template.sections.filter((candidate) => !candidate.on || candidate.on === presentation);
}

export function deriveCatalogStates(
  catalogName: string,
  answers: HistoryTemplateAnswer[],
  sectionId: string,
): { positive: string[]; negative: string[]; unasked: string[] } {
  const byCode = new Map<string, TriState>(answers.flatMap((answer) =>
    answer.sectionId === sectionId && answer.optionCode && answer.value.kind === "tri-state"
      ? [[answer.optionCode, answer.value.status]]
      : []
  ));
  const result = { positive: [] as string[], negative: [] as string[], unasked: [] as string[] };
  for (const option of catalog(catalogName)) {
    const state = byCode.get(option.code);
    result[state ?? "unasked"].push(option.display);
  }
  return result;
}

export function renderDeclaredComplaintNarrative(template: HistoryTemplate, answers: HistoryTemplateAnswer[]): string {
  const override = answers.find((answer) => answer.sectionId === "narrative-override");
  if (override?.value.kind === "text" && override.value.text.trim()) return override.value.text.trim();
  const presentation = selectionDisplay(template.presentations, answers.find((answer) => answer.sectionId === "presentation"));
  const sections = activeTemplateSections(template, selectionCode(answers.find((answer) => answer.sectionId === "presentation")));
  const sectionById = new Map(sections.map((candidate) => [candidate.id, candidate]));
  const replacements = new Map<string, string>([
    ["presentation", presentation?.toLowerCase() ?? ""],
    ["symptoms", triStateClause(sectionById.get("symptoms"), answers, "Reports", "Denies")],
    ["treatment.current", catalogValues(sections.find((candidate) => candidate.type === "treatment" && candidate.when === "current"), answers, true)],
    ["risk_factors.positive", positiveClause(sections.find((candidate) => candidate.type === "risk_factors"), answers, "Risk factors:")],
    ["interval", sectionById.has("interval") ? intervalClause(answers.find((answer) => answer.sectionId === "interval")) : ""],
    ["presents_for", catalogValues(sections.find((candidate) => candidate.type === "presents_for"), answers, false)],
  ]);
  let narrative = template.narrative.replace(/\{([^}]+)\}/g, (_match, expression: string) => {
    const [token, ...arguments_] = expression.split("|");
    if (token === "symptoms") return triStateClause(sectionById.get("symptoms"), answers, arguments_[0] ?? "Reports", arguments_[1] ?? "Denies");
    if (token === "risk_factors.positive") return positiveClause(sections.find((candidate) => candidate.type === "risk_factors"), answers, arguments_[0] ?? "Risk factors:");
    return replacements.get(token) ?? "";
  });
  narrative = narrative
    .replace(/(?:^|\s)(?:Currently on|Current treatment:|Today:)\s*\./g, "")
    .replace(/\s+\./g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
  return narrative.replace(/(\.\s+)([a-z])/g, (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`);
}

export function historyTemplateComplete(template: HistoryTemplate, answers: HistoryTemplateAnswer[]): boolean {
  const presentation = answers.find((answer) => answer.sectionId === "presentation");
  if (presentation?.value.kind !== "selection") return false;
  return activeTemplateSections(template, presentation.value.code)
    .filter((candidate) => candidate.required)
    .every((candidate) => answers.some((answer) => answer.sectionId === candidate.id));
}

export type HistoryCompletenessState = "not-started" | "started" | "charted";

export function historySubjectSectionState(
  declaration: HistorySubjectSection,
  answers: HistoryTemplateAnswer[],
): HistoryCompletenessState {
  if (answers.length === 0) return "not-started";
  const hasAnchor = answers.some((answer) => answer.sectionId === declaration.completionAnchor);
  const hasRequired = declaration.sections.filter((candidate) => candidate.required)
    .every((candidate) => answers.some((answer) => answer.sectionId === candidate.id));
  return hasAnchor && hasRequired ? "charted" : "started";
}

function section(
  id: string,
  type: HistorySectionType,
  label: string,
  details: Partial<Omit<HistoryTemplateSection, "id" | "type" | "label">> = {},
): HistoryTemplateSection {
  return { id, type, label, ...details };
}

function options(rows: Array<[string, string]>): HistoryCatalogOption[] {
  return rows.map(([code, display]) => ({ code, display }));
}

function optionsFromDisplays(displays: string[]): HistoryCatalogOption[] {
  return displays.map((display) => ({ code: slug(display), display }));
}

function ocularOptions(rows: Array<[string, string, boolean]>): HistoryCatalogOption[] {
  return rows.map(([code, display, per_eye]) => ({ code, display, per_eye, note_on_positive: true }));
}

function slug(display: string): string {
  return display.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function catalog(name: string): HistoryCatalogOption[] {
  const value = HISTORY_OPTION_CATALOGS[name];
  if (!value) throw new Error(`Unknown history option catalog: ${name}`);
  return value;
}

function selectionCode(answer: HistoryTemplateAnswer | undefined): string | undefined {
  return answer?.value.kind === "selection" ? answer.value.code : undefined;
}

function selectionDisplay(catalogName: string, answer: HistoryTemplateAnswer | undefined): string | undefined {
  const code = selectionCode(answer);
  return catalog(catalogName).find((option) => option.code === code)?.display;
}

function catalogValues(sectionValue: HistoryTemplateSection | undefined, answers: HistoryTemplateAnswer[], withEye: boolean): string {
  if (!sectionValue?.catalog) return "";
  const positive = answers.filter((answer) =>
    answer.sectionId === sectionValue.id && answer.optionCode && answer.value.kind === "tri-state" && answer.value.status === "positive"
  );
  return catalog(sectionValue.catalog).flatMap((option) => {
    const matching = positive.filter((answer) => answer.optionCode === option.code);
    if (!matching.length) return [];
    if (!withEye) return [option.display];
    const eyes = new Set(matching.flatMap((answer) => answer.eye ? [answer.eye] : []));
    if (eyes.has("OU") || (eyes.has("OD") && eyes.has("OS"))) return [`${option.display} OU`];
    return [...eyes].map((eye) => `${option.display} ${eye}`);
  }).join(", ");
}

function triStateClause(
  sectionValue: HistoryTemplateSection | undefined,
  answers: HistoryTemplateAnswer[],
  positivePrefix: string,
  negativePrefix: string,
): string {
  if (!sectionValue?.catalog) return "";
  const states = deriveCatalogStates(sectionValue.catalog, answers, sectionValue.id);
  return [
    states.positive.length ? `${positivePrefix} ${states.positive.join(", ")}` : "",
    states.negative.length ? `${negativePrefix} ${states.negative.join(", ")}` : "",
  ].filter(Boolean).join(". ");
}

function positiveClause(sectionValue: HistoryTemplateSection | undefined, answers: HistoryTemplateAnswer[], prefix: string): string {
  if (!sectionValue?.catalog) return "";
  const states = deriveCatalogStates(sectionValue.catalog, answers, sectionValue.id);
  return states.positive.length ? `${prefix} ${states.positive.join(", ")}` : "";
}

function intervalClause(answer: HistoryTemplateAnswer | undefined): string {
  if (answer?.value.kind !== "interval") return "";
  const display = answer.value.code[0]!.toUpperCase() + answer.value.code.slice(1);
  return answer.value.note?.trim() ? `${display}; ${answer.value.note.trim()}` : display;
}
