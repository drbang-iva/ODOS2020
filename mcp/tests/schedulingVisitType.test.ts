import assert from "node:assert/strict";
import { test } from "node:test";
import { ODOS_DISCIPLINE_SYSTEM } from "../src/scheduling/clinic-mode.js";
import {
  DISCIPLINE_COLOR_BANDS,
  ODOS_DISPLAY_COLOR_EXTENSION_URL,
  ODOS_ELIGIBLE_RESOURCE_EXTENSION_URL,
  ODOS_INTAKE_FORM_EXTENSION_URL,
  ODOS_VISIT_DURATION_EXTENSION_URL,
  ODOS_VISIT_TYPE_SYSTEM,
  ODOS_VISIT_TYPE_CATEGORY_SYSTEM,
  SCHEDULER_PALETTE,
  buildVisitType,
  defaultVisitTypeCatalog,
  visitTypeCode,
  visitTypeCategory,
  visitTypeColor,
  visitTypeDiscipline,
  visitTypeDurationMinutes,
  visitTypeEligibleResourceReferences,
} from "../src/fhir/schedulingVisitType.js";

test("buildVisitType builds a HealthcareService catalog entry: discipline category, visit-type coding, name", () => {
  const hs = buildVisitType({
    code: "routine-exam-new",
    name: "Routine Exam (New)",
    discipline: "eyecare",
    durationMinutes: 30,
    color: "#4a7dff",
  });
  assert.equal(hs.resourceType, "HealthcareService");
  assert.equal(hs.name, "Routine Exam (New)");
  assert.equal(hs.active, true);
  assert.equal(hs.appointmentRequired, true);
  const categoryCoding = hs.category?.[0]?.coding?.[0];
  assert.equal(categoryCoding?.system, ODOS_DISCIPLINE_SYSTEM);
  assert.equal(categoryCoding?.code, "eyecare");
  const typeCoding = hs.type?.[0]?.coding?.[0];
  assert.equal(typeCoding?.system, ODOS_VISIT_TYPE_SYSTEM);
  assert.equal(typeCoding?.code, "routine-exam-new");
  assert.equal(typeCoding?.display, "Routine Exam (New)");
});

test("duration rides in the odos-visit-duration extension as positiveInt minutes", () => {
  const hs = buildVisitType({
    code: "aesthetics-treatment",
    name: "Aesthetics Treatment",
    discipline: "aesthetics",
    durationMinutes: 60,
    color: "#ee6699",
  });
  const ext = hs.extension?.find((e) => e.url === ODOS_VISIT_DURATION_EXTENSION_URL);
  assert.equal(ext?.valuePositiveInt, 60);
  assert.equal(visitTypeDurationMinutes(hs), 60);
});

test("color rides in the odos-display-color extension; the catalog owns the color (brief §4)", () => {
  const hs = buildVisitType({
    code: "office-visit",
    name: "Office Visit",
    discipline: "eyecare",
    durationMinutes: 20,
    color: "#ff8844",
  });
  const ext = hs.extension?.find((e) => e.url === ODOS_DISPLAY_COLOR_EXTENSION_URL);
  assert.equal(ext?.valueString, "#ff8844");
  assert.equal(visitTypeColor(hs), "#ff8844");
});

test("color defaults to the discipline's primary band color when the operator omits it", () => {
  const eyecare = buildVisitType({
    code: "x",
    name: "X",
    discipline: "eyecare",
    durationMinutes: 30,
  });
  const aesthetics = buildVisitType({
    code: "y",
    name: "Y",
    discipline: "aesthetics",
    durationMinutes: 30,
  });
  assert.equal(visitTypeColor(eyecare), SCHEDULER_PALETTE.newExamBlue);
  assert.equal(visitTypeColor(aesthetics), SCHEDULER_PALETTE.aestheticsCyan);
});

test("eligible resources ride as repeating odos-eligible-resource valueReference extensions", () => {
  const hs = buildVisitType({
    code: "special-testing",
    name: "Special Testing",
    discipline: "eyecare",
    durationMinutes: 30,
    color: "#cc88ff",
    eligibleResourceReferences: ["Device/oct-1", "Location/testing-room"],
  });
  const refs = hs.extension
    ?.filter((e) => e.url === ODOS_ELIGIBLE_RESOURCE_EXTENSION_URL)
    .map((e) => e.valueReference?.reference);
  assert.deepEqual(refs, ["Device/oct-1", "Location/testing-room"]);
  assert.deepEqual(visitTypeEligibleResourceReferences(hs), [
    "Device/oct-1",
    "Location/testing-room",
  ]);
});

test("an intake form rides in the odos-intake-form extension (GHL service-menu model)", () => {
  const hs = buildVisitType({
    code: "aesthetics-consult",
    name: "Aesthetics Consult",
    discipline: "aesthetics",
    durationMinutes: 30,
    color: "#22aabb",
    intakeFormReference: "Questionnaire/aesthetics-intake",
  });
  const ext = hs.extension?.find((e) => e.url === ODOS_INTAKE_FORM_EXTENSION_URL);
  assert.equal(ext?.valueReference?.reference, "Questionnaire/aesthetics-intake");
});

test("builder validation: bad duration, malformed color, empty name/code, unknown discipline all throw", () => {
  const base = { code: "x", name: "X", discipline: "eyecare", durationMinutes: 30 } as const;
  assert.throws(() => buildVisitType({ ...base, durationMinutes: 0 }), /duration/i);
  assert.throws(() => buildVisitType({ ...base, durationMinutes: 12.5 }), /duration/i);
  assert.throws(() => buildVisitType({ ...base, color: "blue" }), /color/i);
  assert.throws(() => buildVisitType({ ...base, name: "" }), /name/i);
  assert.throws(() => buildVisitType({ ...base, code: "" }), /code/i);
  assert.throws(() => buildVisitType({ ...base, discipline: "dental" }), /discipline/i);
});

test("readers recover code + discipline from a catalog entry (round-trip)", () => {
  const hs = buildVisitType({
    code: "routine-exam-established",
    name: "Routine Exam (Established)",
    discipline: "eyecare",
    durationMinutes: 30,
    color: "#44ddaa",
  });
  assert.equal(visitTypeCode(hs), "routine-exam-established");
  assert.equal(visitTypeDiscipline(hs), "eyecare");
});

test("category is a second HealthcareService.category axis and discipline remains untouched", () => {
  const hs = buildVisitType({
    code: "dry-eye-consult",
    name: "Dry Eye Consult",
    discipline: "eyecare",
    categoryCode: "dry-eye",
    categoryLabel: "Dry Eye",
    durationMinutes: 45,
  });
  assert.equal(hs.category?.length, 2);
  assert.equal(hs.category?.[0]?.coding?.[0]?.system, ODOS_DISCIPLINE_SYSTEM);
  assert.equal(hs.category?.[0]?.coding?.[0]?.code, "eyecare");
  assert.equal(hs.category?.[1]?.coding?.[0]?.system, ODOS_VISIT_TYPE_CATEGORY_SYSTEM);
  assert.equal(visitTypeCategory(hs)?.code, "dry-eye");
  assert.equal(visitTypeCategory(hs)?.display, "Dry Eye");
});

test("the default catalog filters by clinic mode — modularity exercised at the catalog layer (brief §1)", () => {
  const eyecareOnly = defaultVisitTypeCatalog("eyecare");
  const aestheticsOnly = defaultVisitTypeCatalog("aesthetics");
  const combined = defaultVisitTypeCatalog("both");
  assert.ok(eyecareOnly.length >= 4);
  assert.ok(aestheticsOnly.length >= 3);
  assert.equal(combined.length, eyecareOnly.length + aestheticsOnly.length);
  assert.ok(eyecareOnly.every((hs) => visitTypeDiscipline(hs) === "eyecare"));
  assert.ok(aestheticsOnly.every((hs) => visitTypeDiscipline(hs) === "aesthetics"));
});

test("the eyecare catalog resolves the shipped contact-lens visit types", () => {
  const catalogByCode = new Map(
    defaultVisitTypeCatalog("eyecare").map((visitType) => [visitTypeCode(visitType), visitType]),
  );
  const eyecareBand = new Set<string>(DISCIPLINE_COLOR_BANDS.eyecare);
  const expected = [
    { code: "contact-lens-exam", display: "Contact Lens Exam", durationMinutes: 30 },
    {
      code: "contact-lens-follow-up",
      display: "Contact Lens Follow-Up",
      durationMinutes: 15,
    },
  ] as const;

  for (const { code, display, durationMinutes } of expected) {
    const visitType = catalogByCode.get(code);
    assert.ok(visitType, `${code} missing from shipped eyecare catalog`);
    assert.equal(visitType.type?.[0]?.coding?.[0]?.display, display);
    assert.equal(visitTypeDurationMinutes(visitType), durationMinutes);
    assert.ok(
      eyecareBand.has(visitTypeColor(visitType)!),
      `${code} color outside the eyecare band`,
    );
  }
});

test("combined-mode color rule: every default color sits in its own discipline's band, and the bands are disjoint", () => {
  const eyecareBand = new Set<string>(DISCIPLINE_COLOR_BANDS.eyecare);
  const aestheticsBand = new Set<string>(DISCIPLINE_COLOR_BANDS.aesthetics);
  for (const color of aestheticsBand) {
    assert.ok(!eyecareBand.has(color), `band overlap on ${color}`);
  }
  for (const hs of defaultVisitTypeCatalog("both")) {
    const band = visitTypeDiscipline(hs) === "eyecare" ? eyecareBand : aestheticsBand;
    assert.ok(band.has(visitTypeColor(hs)!), `${hs.name} color outside its discipline band`);
  }
});

test("the palette carries the v8 front-desk hex values (brief §4 shipped defaults)", () => {
  assert.equal(SCHEDULER_PALETTE.newExamBlue, "#4a7dff");
  assert.equal(SCHEDULER_PALETTE.establishedTeal, "#44ddaa");
  assert.equal(SCHEDULER_PALETTE.specialTestingPurple, "#cc88ff");
  assert.equal(SCHEDULER_PALETTE.officeVisitOrange, "#ff8844");
  assert.equal(SCHEDULER_PALETTE.nonPatientGold, "#ffcc44");
  assert.equal(SCHEDULER_PALETTE.urgentRed, "#ff5555");
  assert.equal(SCHEDULER_PALETTE.aestheticsCyan, "#22aabb");
});
