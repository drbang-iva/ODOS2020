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
  type HistoryTemplateAnswer,
} from "../src/clinical-graph/history-template-engine.js";

test("history templates expose the fixed section vocabulary and only the Slice 1a declarations", () => {
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
