import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORY_OPTION_CATALOGS,
  HISTORY_SECTION_TYPES,
  HISTORY_SUBJECT_SECTIONS,
  HISTORY_TEMPLATES,
  activeTemplateSections,
  cycleTriState,
  deriveCatalogStates,
  historyTemplateComplete,
  historySubjectSectionState,
  renderDeclaredComplaintNarrative,
  renderDeclaredSubjectSummary,
  type HistoryTemplateAnswer,
} from "../src/clinical-graph/history-template-engine.js";

test("history templates expose the fixed section vocabulary and the Slice 1a complaint declarations", () => {
  assert.deepEqual(HISTORY_SECTION_TYPES, [
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
    "family_conditions",
  ]);
  assert.deepEqual(HISTORY_TEMPLATES.map((template) => template.complaint), ["glaucoma", "routine"]);
});

test("Ocular History is a patient-scoped declaration with conditions and surgeries", () => {
  const ocular = HISTORY_SUBJECT_SECTIONS.find((section) => section.key === "ocular-history");
  assert.ok(ocular);
  assert.equal(ocular.subjectScope, "patient");
  assert.equal(ocular.completionAnchor, "conditions");
  assert.deepEqual(ocular.sections.map((section) => [section.id, section.catalog, section.required]), [
    ["conditions", "ocular_history_conditions", true],
    ["surgeries", "ocular_history_surgeries", true],
  ]);
  assert.deepEqual(HISTORY_OPTION_CATALOGS.ocular_history_conditions.find((option) => option.code === "glaucoma"), {
    code: "glaucoma",
    display: "Glaucoma",
    per_eye: true,
    note_on_positive: true,
  });
  assert.equal(HISTORY_OPTION_CATALOGS.ocular_history_conditions.find((option) => option.code === "strabismus")?.per_eye, false);
});

test("Medical and Social History are patient-scoped declarations using the declared section vocabulary", () => {
  const medical = HISTORY_SUBJECT_SECTIONS.find((section) => section.key === "medical-history");
  assert.ok(medical);
  assert.equal(medical.subjectScope, "patient");
  assert.equal(medical.completionAnchor, "conditions");
  assert.deepEqual(medical.sections.map((section) => [section.id, section.type, section.catalog, section.per_eye, section.required]), [
    ["conditions", "risk_factors", "medical_history_conditions", undefined, true],
    ["ophthalmic-medications", "treatment", "medical_history_ophthalmic_medications", true, true],
    ["systemic-medications", "treatment", "medical_history_systemic_medications", false, true],
    ["allergies", "risk_factors", "medical_history_allergies", undefined, true],
  ]);

  const social = HISTORY_SUBJECT_SECTIONS.find((section) => section.key === "social-history");
  assert.ok(social);
  assert.equal(social.subjectScope, "patient");
  assert.equal(social.completionAnchor, "tobacco");
  assert.deepEqual(social.sections.map((section) => [section.id, section.type, section.catalog, section.required]), [
    ["tobacco", "single_select", "tobacco_status", true],
    ["driving", "risk_factors", "social_history_driving", true],
    ["alcohol-drugs", "risk_factors", "social_history_alcohol_drugs", true],
    ["occupation", "text", undefined, undefined],
    ["home-safety", "risk_factors", "social_history_home_safety", true],
  ]);
  assert.deepEqual(HISTORY_OPTION_CATALOGS.tobacco_status, [
    { code: "never", display: "Never" },
    { code: "former-smoker", display: "Former smoker" },
    { code: "current", display: "Current" },
  ]);
  assert.deepEqual(HISTORY_OPTION_CATALOGS.medical_history_allergies, [
    { code: "no-known-drug-allergies", display: "No known drug allergies" },
  ]);
});

test("Family History declares condition rows and the fourteen slug-only family relations", () => {
  const family = HISTORY_SUBJECT_SECTIONS.find((section) => section.key === "family-history");
  assert.ok(family);
  assert.equal(family.subjectScope, "patient");
  assert.equal(family.completionAnchor, "conditions");
  assert.equal(family.summary, "{family_conditions}");
  assert.equal(family.charted_when, undefined);
  assert.deepEqual(family.sections, [
    { id: "conditions", type: "family_conditions", label: "Conditions", catalog: "family_conditions", relations: "family_relations", required: true },
    { id: "notes", type: "text", label: "Other family history" },
  ]);
  assert.deepEqual(HISTORY_OPTION_CATALOGS.family_conditions, [
    { code: "glaucoma", display: "Glaucoma" },
    { code: "diabetes", display: "Diabetes" },
  ]);
  assert.deepEqual(HISTORY_OPTION_CATALOGS.family_relations, [
    { code: "mother", display: "Mother" },
    { code: "father", display: "Father" },
    { code: "sister", display: "Sister" },
    { code: "brother", display: "Brother" },
    { code: "daughter", display: "Daughter" },
    { code: "son", display: "Son" },
    { code: "uncle", display: "Uncle" },
    { code: "aunt", display: "Aunt" },
    { code: "nephew", display: "Nephew" },
    { code: "niece", display: "Niece" },
    { code: "grandmother", display: "Grandmother" },
    { code: "grandfather", display: "Grandfather" },
    { code: "grandson", display: "Grandson" },
    { code: "granddaughter", display: "Granddaughter" },
  ]);
});

test("Family History summary names positive relatives while retaining denied and unasked states in the answer", () => {
  const family = HISTORY_SUBJECT_SECTIONS.find((section) => section.key === "family-history")!;
  const answers: HistoryTemplateAnswer[] = [
    {
      id: "family-e1-conditions-glaucoma",
      subjectScope: "patient",
      templateKey: "family-history",
      sectionId: "conditions",
      optionCode: "glaucoma",
      value: { kind: "relations", positive: ["father", "brother"], negative: ["mother"] },
    },
    {
      id: "family-e1-conditions-diabetes",
      subjectScope: "patient",
      templateKey: "family-history",
      sectionId: "conditions",
      optionCode: "diabetes",
      value: { kind: "relations", positive: ["mother"], negative: [] },
    },
  ];

  assert.equal(historySubjectSectionState(family, answers), "charted");
  assert.equal(renderDeclaredSubjectSummary(family, answers, { encounterStart: "2026-09-05T12:00:00Z", lastReviewed: [] }),
    "Glaucoma — father, brother · Diabetes — mother");
  assert.deepEqual(answers[0]?.value, { kind: "relations", positive: ["father", "brother"], negative: ["mother"] });
});

test("patient-section completeness distinguishes not started, started, and charted", () => {
  const ocular = HISTORY_SUBJECT_SECTIONS.find((section) => section.key === "ocular-history")!;
  const condition = patientAnswer("conditions", "glaucoma", "OD");
  const surgery = patientAnswer("surgeries", "cataract-surgery", "OS");

  assert.equal(historySubjectSectionState(ocular, []), "not-started");
  assert.equal(historySubjectSectionState(ocular, [condition]), "started");
  assert.equal(historySubjectSectionState(ocular, [condition, surgery]), "charted");
});

test("template declarations reference shared catalogs and preserve both glaucoma durations", () => {
  const glaucoma = HISTORY_TEMPLATES.find((template) => template.complaint === "glaucoma");
  assert.ok(glaucoma);
  assert.equal(glaucoma.presentations, "glaucoma_presentations");
  assert.deepEqual(
    glaucoma.sections.filter((section) => section.type === "duration").map((section) => [section.id, section.label]),
    [["symptom-duration", "these symptoms"], ["glaucoma-duration", "glaucoma"]],
  );
  assert.deepEqual(
    glaucoma.sections.filter((section) => section.type === "treatment").map((section) => [section.when, section.per_eye]),
    [["past", false], ["current", true]],
  );
  for (const template of HISTORY_TEMPLATES) {
    assert.ok(HISTORY_OPTION_CATALOGS[template.presentations], `${template.complaint} presentation catalog is missing`);
    for (const section of template.sections) {
      if ("catalog" in section) {
        assert.ok(HISTORY_OPTION_CATALOGS[section.catalog], `${template.complaint}.${section.id} catalog is missing`);
      }
    }
  }
});

test("the same declaration adds interval only for its follow-up presentation", () => {
  const glaucoma = HISTORY_TEMPLATES.find((template) => template.complaint === "glaucoma")!;
  assert.equal(activeTemplateSections(glaucoma, "pressure-check").some((section) => section.type === "interval"), false);
  assert.equal(activeTemplateSections(glaucoma, "follow-up").some((section) => section.type === "interval"), true);
});

test("tri-state cycling keeps negative distinct from an unasked missing answer", () => {
  assert.equal(cycleTriState(undefined), "positive");
  assert.equal(cycleTriState("positive"), "negative");
  assert.equal(cycleTriState("negative"), undefined);

  const answers: HistoryTemplateAnswer[] = [{
    id: "answer-halos",
    complaintId: "complaint-1",
    templateKey: "glaucoma",
    sectionId: "symptoms",
    optionCode: "halos-around-lights",
    value: { kind: "tri-state", status: "negative" },
  }];
  assert.deepEqual(answers[0]?.value, { kind: "tri-state", status: "negative" });
  assert.equal(answers.find((answer) => answer.optionCode === "ocular-pain"), undefined);
});

test("pertinent negatives are derived by partitioning one positive catalog", () => {
  const answers: HistoryTemplateAnswer[] = [
    {
      id: "answer-steroid-nasal",
      complaintId: "complaint-1",
      templateKey: "glaucoma",
      sectionId: "risk-factors",
      optionCode: "steroid-nasal-sprays",
      value: { kind: "tri-state", status: "positive" },
    },
    {
      id: "answer-family-history",
      complaintId: "complaint-1",
      templateKey: "glaucoma",
      sectionId: "risk-factors",
      optionCode: "family-history-of-glaucoma",
      value: { kind: "tri-state", status: "negative" },
    },
  ];
  assert.deepEqual(deriveCatalogStates("glaucoma_risk", answers, "risk-factors"), {
    positive: ["steroid nasal sprays"],
    negative: ["family history of glaucoma"],
    unasked: HISTORY_OPTION_CATALOGS.glaucoma_risk
      .filter((option) => !["steroid-nasal-sprays", "family-history-of-glaucoma"].includes(option.code))
      .map((option) => option.display),
  });
});

test("the declaration narrative composes positive and denied findings without complaint-specific code", () => {
  const glaucoma = HISTORY_TEMPLATES.find((template) => template.complaint === "glaucoma")!;
  const answers: HistoryTemplateAnswer[] = [
    answer("presentation", undefined, { kind: "selection", code: "follow-up" }),
    answer("symptoms", "halos-around-lights", { kind: "tri-state", status: "positive" }),
    answer("symptoms", "ocular-pain", { kind: "tri-state", status: "negative" }),
    answer("current-treatment", "latanoprost", { kind: "tri-state", status: "positive" }, "OD"),
    answer("current-treatment", "latanoprost", { kind: "tri-state", status: "positive" }, "OS"),
    answer("interval", undefined, { kind: "interval", code: "same", note: "No pressure concerns" }),
    answer("presents-for", "iop-check", { kind: "tri-state", status: "positive" }),
  ];
  assert.equal(
    renderDeclaredComplaintNarrative(glaucoma, answers),
    "is being seen for follow up. Reports halos around lights. Denies ocular pain. Currently on latanoprost OU. Same; No pressure concerns. Today: IOP check.",
  );
});

test("the declaration narrative ignores answers from sections inactive for the selected presentation", () => {
  const glaucoma = HISTORY_TEMPLATES.find((template) => template.complaint === "glaucoma")!;
  assert.equal(renderDeclaredComplaintNarrative(glaucoma, [
    answer("presentation", undefined, { kind: "selection", code: "pressure-check" }),
    answer("interval", undefined, { kind: "interval", code: "worse", note: "stale follow-up detail" }),
  ]), "is being seen for pressure check.");
});

test("completeness is derived from the declaration's required sections", () => {
  const glaucoma = HISTORY_TEMPLATES.find((template) => template.complaint === "glaucoma")!;
  const answers: HistoryTemplateAnswer[] = [
    answer("presentation", undefined, { kind: "selection", code: "follow-up" }),
    answer("symptoms", "no-symptoms", { kind: "tri-state", status: "positive" }),
    answer("risk-factors", "family-history-of-glaucoma", { kind: "tri-state", status: "negative" }),
    answer("current-treatment", "no-treatment", { kind: "tri-state", status: "positive" }),
  ];
  assert.equal(historyTemplateComplete(glaucoma, answers), false);
  assert.equal(historyTemplateComplete(glaucoma, [...answers, answer("presents-for", "iop-check", { kind: "tri-state", status: "positive" })]), true);
});

test("a clinician narrative override is longer than and replaces the automated declaration output", () => {
  const glaucoma = HISTORY_TEMPLATES.find((template) => template.complaint === "glaucoma")!;
  const automated = renderDeclaredComplaintNarrative(glaucoma, [
    answer("presentation", undefined, { kind: "selection", code: "follow-up" }),
    answer("symptoms", "ocular-pain", { kind: "tri-state", status: "negative" }),
  ]);
  const override = `${automated} Patient specifically clarified the timing and context of the pressure concern.`;
  assert.equal(renderDeclaredComplaintNarrative(glaucoma, [
    answer("presentation", undefined, { kind: "selection", code: "follow-up" }),
    answer("symptoms", "ocular-pain", { kind: "tri-state", status: "negative" }),
    answer("narrative-override", undefined, { kind: "text", text: override }),
  ]), override);
  assert.ok(override.length > automated.length);
});

function answer(
  sectionId: string,
  optionCode: string | undefined,
  value: HistoryTemplateAnswer["value"],
  eye?: "OD" | "OS" | "OU",
): HistoryTemplateAnswer {
  return {
    id: `answer-${sectionId}-${optionCode ?? "value"}`,
    complaintId: "complaint-1",
    templateKey: "glaucoma",
    sectionId,
    ...(optionCode ? { optionCode } : {}),
    ...(eye ? { eye } : {}),
    value,
  };
}

function patientAnswer(sectionId: string, optionCode: string, eye?: "OD" | "OS"): HistoryTemplateAnswer {
  return {
    id: `ocular-e1-${sectionId}-${optionCode}${eye ? `-${eye}` : ""}`,
    subjectScope: "patient",
    templateKey: "ocular-history",
    sectionId,
    optionCode,
    ...(eye ? { eye } : {}),
    value: { kind: "tri-state", status: "positive" },
  };
}
