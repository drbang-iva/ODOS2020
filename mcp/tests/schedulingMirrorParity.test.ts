import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment, HealthcareService, Schedule } from "@medplum/fhirtypes";
import {
  CLINIC_MODES as MCP_CLINIC_MODES,
  ODOS_DISCIPLINE_SYSTEM as MCP_ODOS_DISCIPLINE_SYSTEM,
  SCHEDULING_DISCIPLINES as MCP_SCHEDULING_DISCIPLINES,
  disciplinesForMode as mcpDisciplinesForMode,
  isDisciplineVisible as mcpIsDisciplineVisible,
} from "../src/scheduling/clinic-mode.js";
import {
  RESOURCE_KINDS as MCP_RESOURCE_KINDS,
  buildSchedulingResource,
  isResourceVisibleInMode as mcpIsResourceVisibleInMode,
  resourceDisciplines as mcpResourceDisciplines,
  resourceKind as mcpResourceKind,
} from "../src/fhir/schedulingResource.js";
import {
  DISCIPLINE_COLOR_BANDS as MCP_DISCIPLINE_COLOR_BANDS,
  ODOS_DISPLAY_COLOR_EXTENSION_URL as MCP_ODOS_DISPLAY_COLOR_EXTENSION_URL,
  ODOS_ELIGIBLE_RESOURCE_EXTENSION_URL as MCP_ODOS_ELIGIBLE_RESOURCE_EXTENSION_URL,
  ODOS_INTAKE_FORM_EXTENSION_URL as MCP_ODOS_INTAKE_FORM_EXTENSION_URL,
  ODOS_VISIT_DURATION_EXTENSION_URL as MCP_ODOS_VISIT_DURATION_EXTENSION_URL,
  ODOS_VISIT_TYPE_SYSTEM as MCP_ODOS_VISIT_TYPE_SYSTEM,
  ODOS_VISIT_TYPE_CATEGORY_SYSTEM as MCP_ODOS_VISIT_TYPE_CATEGORY_SYSTEM,
  SCHEDULER_PALETTE as MCP_SCHEDULER_PALETTE,
  buildVisitType,
  defaultVisitTypeCatalog,
  visitTypeCode as mcpVisitTypeCode,
  visitTypeCategory as mcpVisitTypeCategory,
  visitTypeColor as mcpVisitTypeColor,
  visitTypeDiscipline as mcpVisitTypeDiscipline,
  visitTypeDurationMinutes as mcpVisitTypeDurationMinutes,
  visitTypeEligibleResourceReferences as mcpVisitTypeEligibleResourceReferences,
} from "../src/fhir/schedulingVisitType.js";
import {
  APPOINTMENT_CONFIRMATION_STATUSES as MCP_APPOINTMENT_CONFIRMATION_STATUSES,
  ODOS_APPOINTMENT_CONFIRMATION_EXTENSION_URL as MCP_ODOS_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
  ODOS_APPOINTMENT_CONFIRMATION_SYSTEM as MCP_ODOS_APPOINTMENT_CONFIRMATION_SYSTEM,
  confirmationStatusOf as mcpConfirmationStatusOf,
} from "../src/fhir/appointmentConfirmation.js";
import {
  ODOS_APPOINTMENT_STATUSES as MCP_ODOS_APPOINTMENT_STATUSES,
  V2_0276_APPOINTMENT_TYPE_SYSTEM as MCP_V2_0276_APPOINTMENT_TYPE_SYSTEM,
  odosAppointmentStatusOf as mcpOdosAppointmentStatusOf,
} from "../src/fhir/schedulingAppointmentStatus.js";
import {
  ODOS_FOLLOW_UP_EXTENSION_URL as MCP_ODOS_FOLLOW_UP_EXTENSION_URL,
  ODOS_MEDICAL_COVERAGE_EXTENSION_URL as MCP_ODOS_MEDICAL_COVERAGE_EXTENSION_URL,
  ODOS_VISION_COVERAGE_EXTENSION_URL as MCP_ODOS_VISION_COVERAGE_EXTENSION_URL,
  appointmentVisitTypeCode as mcpAppointmentVisitTypeCode,
  buildSchedulingAppointment,
  isFollowUpAppointment as mcpIsFollowUpAppointment,
  isUrgentAppointment as mcpIsUrgentAppointment,
  medicalCoverageOf as mcpMedicalCoverageOf,
  visionCoverageOf as mcpVisionCoverageOf,
} from "../src/fhir/schedulingAppointment.js";
import {
  BLOCKED_TIME_KINDS as MCP_BLOCKED_TIME_KINDS,
  ODOS_BLOCKED_TIME_KIND_EXTENSION_URL as MCP_ODOS_BLOCKED_TIME_KIND_EXTENSION_URL,
  ODOS_BLOCKED_TIME_KIND_SYSTEM as MCP_ODOS_BLOCKED_TIME_KIND_SYSTEM,
  blockedTimeKindOf as mcpBlockedTimeKindOf,
  generateSlots,
} from "../src/scheduling/availability.js";
import {
  ODOS_SCHEDULING_CONFIG_CODE as MCP_ODOS_SCHEDULING_CONFIG_CODE,
  ODOS_SCHEDULING_CONFIG_EXTENSION_URL as MCP_ODOS_SCHEDULING_CONFIG_EXTENSION_URL,
  ODOS_SCHEDULING_CONFIG_SYSTEM as MCP_ODOS_SCHEDULING_CONFIG_SYSTEM,
  buildSchedulingPracticeConfigResource as mcpBuildSchedulingPracticeConfigResource,
  parseSchedulingPracticeConfig as mcpParseSchedulingPracticeConfig,
  type PersistedSchedulingPracticeConfig as McpPersistedSchedulingPracticeConfig,
} from "../src/scheduling/practice-config.js";
import {
  APPOINTMENT_CONFIRMATION_STATUSES as UI_APPOINTMENT_CONFIRMATION_STATUSES,
  BLOCKED_TIME_KINDS as UI_BLOCKED_TIME_KINDS,
  CLINIC_MODES as UI_CLINIC_MODES,
  DISCIPLINE_COLOR_BANDS as UI_DISCIPLINE_COLOR_BANDS,
  ODOS_APPOINTMENT_CONFIRMATION_EXTENSION_URL as UI_ODOS_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
  ODOS_APPOINTMENT_CONFIRMATION_SYSTEM as UI_ODOS_APPOINTMENT_CONFIRMATION_SYSTEM,
  ODOS_APPOINTMENT_STATUSES as UI_ODOS_APPOINTMENT_STATUSES,
  ODOS_BLOCKED_TIME_KIND_EXTENSION_URL as UI_ODOS_BLOCKED_TIME_KIND_EXTENSION_URL,
  ODOS_BLOCKED_TIME_KIND_SYSTEM as UI_ODOS_BLOCKED_TIME_KIND_SYSTEM,
  ODOS_DISCIPLINE_SYSTEM as UI_ODOS_DISCIPLINE_SYSTEM,
  ODOS_DISPLAY_COLOR_EXTENSION_URL as UI_ODOS_DISPLAY_COLOR_EXTENSION_URL,
  ODOS_ELIGIBLE_RESOURCE_EXTENSION_URL as UI_ODOS_ELIGIBLE_RESOURCE_EXTENSION_URL,
  ODOS_FOLLOW_UP_EXTENSION_URL as UI_ODOS_FOLLOW_UP_EXTENSION_URL,
  ODOS_INTAKE_FORM_EXTENSION_URL as UI_ODOS_INTAKE_FORM_EXTENSION_URL,
  ODOS_MEDICAL_COVERAGE_EXTENSION_URL as UI_ODOS_MEDICAL_COVERAGE_EXTENSION_URL,
  ODOS_VISION_COVERAGE_EXTENSION_URL as UI_ODOS_VISION_COVERAGE_EXTENSION_URL,
  ODOS_VISIT_DURATION_EXTENSION_URL as UI_ODOS_VISIT_DURATION_EXTENSION_URL,
  ODOS_VISIT_TYPE_SYSTEM as UI_ODOS_VISIT_TYPE_SYSTEM,
  ODOS_VISIT_TYPE_CATEGORY_SYSTEM as UI_ODOS_VISIT_TYPE_CATEGORY_SYSTEM,
  NON_BLOCKING_APPOINTMENT_STATUSES as UI_NON_BLOCKING_APPOINTMENT_STATUSES,
  RESOURCE_KINDS as UI_RESOURCE_KINDS,
  SCHEDULER_PALETTE as UI_SCHEDULER_PALETTE,
  SCHEDULING_DISCIPLINES as UI_SCHEDULING_DISCIPLINES,
  V2_0276_APPOINTMENT_TYPE_SYSTEM as UI_V2_0276_APPOINTMENT_TYPE_SYSTEM,
  appointmentVisitTypeCode as uiAppointmentVisitTypeCode,
  blockedTimeKindOf as uiBlockedTimeKindOf,
  buildVisitType as uiBuildVisitType,
  defaultVisitTypeCatalog as uiDefaultVisitTypeCatalog,
  buildSchedulingAppointment as uiBuildSchedulingAppointment,
  confirmationStatusOf as uiConfirmationStatusOf,
  disciplinesForMode as uiDisciplinesForMode,
  isDisciplineVisible as uiIsDisciplineVisible,
  isFollowUpAppointment as uiIsFollowUpAppointment,
  isResourceVisibleInMode as uiIsResourceVisibleInMode,
  isUrgentAppointment as uiIsUrgentAppointment,
  medicalCoverageOf as uiMedicalCoverageOf,
  odosAppointmentStatusOf as uiOdosAppointmentStatusOf,
  validateAndBuildSchedulingAppointment as uiValidateAndBuildSchedulingAppointment,
  resourceDisciplines as uiResourceDisciplines,
  resourceKind as uiResourceKind,
  visitTypeCode as uiVisitTypeCode,
  visitTypeCategory as uiVisitTypeCategory,
  visitTypeColor as uiVisitTypeColor,
  visitTypeDiscipline as uiVisitTypeDiscipline,
  visitTypeDisplayColor as uiVisitTypeDisplayColor,
  visitTypeDurationMinutes as uiVisitTypeDurationMinutes,
  visitTypeEligibleResourceReferences as uiVisitTypeEligibleResourceReferences,
  visionCoverageOf as uiVisionCoverageOf,
} from "../../ui/src/lib/scheduling.js";
import {
  ODOS_SCHEDULING_CONFIG_CODE as UI_ODOS_SCHEDULING_CONFIG_CODE,
  ODOS_SCHEDULING_CONFIG_EXTENSION_URL as UI_ODOS_SCHEDULING_CONFIG_EXTENSION_URL,
  ODOS_SCHEDULING_CONFIG_SYSTEM as UI_ODOS_SCHEDULING_CONFIG_SYSTEM,
  buildSchedulingPracticeConfigResource as uiBuildSchedulingPracticeConfigResource,
  parseSchedulingPracticeConfig as uiParseSchedulingPracticeConfig,
} from "../../ui/src/lib/scheduling-config.js";
import {
  buildCatalogFields as mcpBuildCatalogFields,
  parseCatalogFields as mcpParseCatalogFields,
  type CatalogFieldDefinition as McpCatalogFieldDefinition,
} from "../src/settings/catalog-field-kernel.js";
import {
  buildCatalogFields as uiBuildCatalogFields,
  parseCatalogFields as uiParseCatalogFields,
  type CatalogFieldDefinition as UiCatalogFieldDefinition,
} from "../../ui/src/lib/catalog-field-kernel.js";

function defaultMirrorCatalog(): HealthcareService[] {
  return defaultVisitTypeCatalog("both").map((visitType, index) => ({
    ...visitType,
    id: `vt-${index + 1}`,
  }));
}

function defaultMirrorResources(): Schedule[] {
  return [
    {
      ...buildSchedulingResource({
        kind: "provider",
        actorReference: "Practitioner/bang-eric",
        actorDisplay: "Bang, Eric",
        disciplines: ["eyecare"],
      }),
      id: "sch-provider",
    },
    {
      ...buildSchedulingResource({
        kind: "room",
        actorReference: "Location/treatment-room",
        actorDisplay: "Treatment Room",
        disciplines: ["aesthetics"],
      }),
      id: "sch-room",
    },
  ];
}

const PRACTICE_CONFIG: McpPersistedSchedulingPracticeConfig = {
  timezoneOffset: "-05:00",
  defaultWeeklyHours: {
    mon: [{ start: "08:00", end: "17:00" }],
    fri: [{ start: "08:00", end: "12:00" }],
  },
  weeklyHoursBySchedule: {
    "Schedule/sch-1": { tue: [{ start: "10:00", end: "18:00" }] },
  },
  blocks: [
    {
      kind: "custom",
      description: "Lunch",
      weekdays: ["mon", "tue", "wed", "thu", "fri"],
      start: "12:00",
      end: "13:00",
    },
    {
      kind: "staff-off",
      date: "2026-07-10",
      scheduleReferences: ["Schedule/sch-1"],
    },
  ],
  offices: [{ id: "main", name: "Main Office" }],
  officeBySchedule: { "Schedule/sch-1": "main" },
};

test("UI scheduler mirror constants match the Phase-1 kernel", () => {
  assert.deepEqual(UI_CLINIC_MODES, MCP_CLINIC_MODES);
  assert.deepEqual(UI_SCHEDULING_DISCIPLINES, MCP_SCHEDULING_DISCIPLINES);
  assert.equal(UI_ODOS_DISCIPLINE_SYSTEM, MCP_ODOS_DISCIPLINE_SYSTEM);
  assert.deepEqual(UI_RESOURCE_KINDS, MCP_RESOURCE_KINDS);
  assert.equal(UI_ODOS_VISIT_TYPE_SYSTEM, MCP_ODOS_VISIT_TYPE_SYSTEM);
  assert.equal(UI_ODOS_VISIT_TYPE_CATEGORY_SYSTEM, MCP_ODOS_VISIT_TYPE_CATEGORY_SYSTEM);
  assert.equal(UI_ODOS_VISIT_DURATION_EXTENSION_URL, MCP_ODOS_VISIT_DURATION_EXTENSION_URL);
  assert.equal(UI_ODOS_DISPLAY_COLOR_EXTENSION_URL, MCP_ODOS_DISPLAY_COLOR_EXTENSION_URL);
  assert.equal(UI_ODOS_ELIGIBLE_RESOURCE_EXTENSION_URL, MCP_ODOS_ELIGIBLE_RESOURCE_EXTENSION_URL);
  assert.equal(UI_ODOS_INTAKE_FORM_EXTENSION_URL, MCP_ODOS_INTAKE_FORM_EXTENSION_URL);
  assert.deepEqual(UI_SCHEDULER_PALETTE, MCP_SCHEDULER_PALETTE);
  assert.deepEqual(UI_DISCIPLINE_COLOR_BANDS, MCP_DISCIPLINE_COLOR_BANDS);
  assert.equal(
    UI_ODOS_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
    MCP_ODOS_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
  );
  assert.equal(UI_ODOS_APPOINTMENT_CONFIRMATION_SYSTEM, MCP_ODOS_APPOINTMENT_CONFIRMATION_SYSTEM);
  assert.deepEqual(UI_APPOINTMENT_CONFIRMATION_STATUSES, MCP_APPOINTMENT_CONFIRMATION_STATUSES);
  assert.deepEqual(UI_ODOS_APPOINTMENT_STATUSES, MCP_ODOS_APPOINTMENT_STATUSES);
  assert.equal(UI_V2_0276_APPOINTMENT_TYPE_SYSTEM, MCP_V2_0276_APPOINTMENT_TYPE_SYSTEM);
  assert.equal(UI_ODOS_VISION_COVERAGE_EXTENSION_URL, MCP_ODOS_VISION_COVERAGE_EXTENSION_URL);
  assert.equal(UI_ODOS_MEDICAL_COVERAGE_EXTENSION_URL, MCP_ODOS_MEDICAL_COVERAGE_EXTENSION_URL);
  assert.equal(UI_ODOS_FOLLOW_UP_EXTENSION_URL, MCP_ODOS_FOLLOW_UP_EXTENSION_URL);
  assert.equal(UI_ODOS_BLOCKED_TIME_KIND_EXTENSION_URL, MCP_ODOS_BLOCKED_TIME_KIND_EXTENSION_URL);
  assert.equal(UI_ODOS_BLOCKED_TIME_KIND_SYSTEM, MCP_ODOS_BLOCKED_TIME_KIND_SYSTEM);
  assert.deepEqual(UI_BLOCKED_TIME_KINDS, MCP_BLOCKED_TIME_KINDS);
  assert.deepEqual(UI_NON_BLOCKING_APPOINTMENT_STATUSES, ["cancelled", "entered-in-error"]);
});

test("UI visit-type builder mirrors category mapping and the shipped default catalog", () => {
  const input = {
    code: "dry-eye-consult",
    name: "Dry Eye Consult",
    discipline: "eyecare",
    categoryCode: "dry-eye",
    categoryLabel: "Dry Eye",
    durationMinutes: 45,
    color: MCP_SCHEDULER_PALETTE.specialTestingPurple,
  };
  const mcp = buildVisitType(input);
  const ui = uiBuildVisitType(input);
  assert.deepEqual(ui, mcp);
  assert.deepEqual(uiVisitTypeCategory(ui), mcpVisitTypeCategory(mcp));
  assert.deepEqual(uiDefaultVisitTypeCatalog("both"), defaultVisitTypeCatalog("both"));
});

test("UI scheduler practice-config mirror constants match the Phase-4a kernel", () => {
  assert.equal(UI_ODOS_SCHEDULING_CONFIG_SYSTEM, MCP_ODOS_SCHEDULING_CONFIG_SYSTEM);
  assert.equal(UI_ODOS_SCHEDULING_CONFIG_CODE, MCP_ODOS_SCHEDULING_CONFIG_CODE);
  assert.equal(
    UI_ODOS_SCHEDULING_CONFIG_EXTENSION_URL,
    MCP_ODOS_SCHEDULING_CONFIG_EXTENSION_URL,
  );
});

test("UI scheduler practice-config mirror build/parse round-trip matches the kernel", () => {
  const existing = mcpBuildSchedulingPracticeConfigResource(PRACTICE_CONFIG);
  existing.id = "cfg-1";
  existing.meta = { versionId: "7" };

  assert.deepEqual(
    uiBuildSchedulingPracticeConfigResource(PRACTICE_CONFIG, existing),
    mcpBuildSchedulingPracticeConfigResource(PRACTICE_CONFIG, existing),
  );
  assert.deepEqual(
    uiParseSchedulingPracticeConfig(uiBuildSchedulingPracticeConfigResource(PRACTICE_CONFIG)),
    mcpParseSchedulingPracticeConfig(mcpBuildSchedulingPracticeConfigResource(PRACTICE_CONFIG)),
  );
});

test("UI scheduler practice-config mirror validation errors match the kernel verbatim", () => {
  assert.throws(
    () => uiBuildSchedulingPracticeConfigResource({ ...PRACTICE_CONFIG, timezoneOffset: "EST" }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.throws(
        () => mcpBuildSchedulingPracticeConfigResource({ ...PRACTICE_CONFIG, timezoneOffset: "EST" }),
        { message: err.message },
      );
      return true;
    },
  );
  assert.throws(
    () =>
      uiBuildSchedulingPracticeConfigResource({
        ...PRACTICE_CONFIG,
        blocks: [{ kind: "holiday" as never, date: "2026-07-10" }],
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.throws(
        () =>
          mcpBuildSchedulingPracticeConfigResource({
            ...PRACTICE_CONFIG,
            blocks: [{ kind: "holiday" as never, date: "2026-07-10" }],
          }),
        { message: err.message },
      );
      return true;
    },
  );
});

test("UI scheduler practice-config mirror weekly-hours errors match the kernel verbatim", () => {
  const cases: McpPersistedSchedulingPracticeConfig[] = [
    { ...PRACTICE_CONFIG, defaultWeeklyHours: { mon: [{ start: "8am", end: "12:00" }] } },
    { ...PRACTICE_CONFIG, defaultWeeklyHours: { mon: [{ start: "12:00", end: "12:00" }] } },
    {
      ...PRACTICE_CONFIG,
      weeklyHoursBySchedule: { "Schedule/sch-1": { tue: [{ start: "noon", end: "18:00" }] } },
    },
    {
      ...PRACTICE_CONFIG,
      weeklyHoursBySchedule: { "Schedule/sch-1": { tue: [{ start: "18:00", end: "10:00" }] } },
    },
  ];

  for (const candidate of cases) {
    assert.throws(
      () => uiBuildSchedulingPracticeConfigResource(candidate),
      (err) => {
        assert.ok(err instanceof Error);
        assert.throws(() => mcpBuildSchedulingPracticeConfigResource(candidate), {
          message: err.message,
        });
        return true;
      },
    );
  }
});

test("UI scheduler practice-config mirror block and office errors match the kernel verbatim", () => {
  const cases: McpPersistedSchedulingPracticeConfig[] = [
    { ...PRACTICE_CONFIG, blocks: [{ kind: "custom" }] },
    { ...PRACTICE_CONFIG, blocks: [{ kind: "custom", date: "07/10/2026" }] },
    { ...PRACTICE_CONFIG, blocks: [{ kind: "custom", date: "2026-07-10", start: "8am" }] },
    { ...PRACTICE_CONFIG, blocks: [{ kind: "custom", date: "2026-07-10", end: "5pm" }] },
    { ...PRACTICE_CONFIG, officeBySchedule: { "Schedule/sch-1": "missing-office" } },
  ];

  for (const candidate of cases) {
    assert.throws(
      () => uiBuildSchedulingPracticeConfigResource(candidate),
      (err) => {
        assert.ok(err instanceof Error);
        assert.throws(() => mcpBuildSchedulingPracticeConfigResource(candidate), {
          message: err.message,
        });
        return true;
      },
    );
  }
});

test("UI scheduler practice-config mirror parse errors match the kernel verbatim", () => {
  const validRaw = JSON.stringify(PRACTICE_CONFIG);
  const cases = [
    {
      resourceType: "Basic",
      code: { coding: [{ system: "https://wrong.example", code: "wrong" }] },
      extension: [{ url: UI_ODOS_SCHEDULING_CONFIG_EXTENSION_URL, valueString: validRaw }],
    },
    {
      resourceType: "Basic",
      code: {
        coding: [{ system: UI_ODOS_SCHEDULING_CONFIG_SYSTEM, code: UI_ODOS_SCHEDULING_CONFIG_CODE }],
      },
    },
    {
      resourceType: "Basic",
      code: {
        coding: [{ system: UI_ODOS_SCHEDULING_CONFIG_SYSTEM, code: UI_ODOS_SCHEDULING_CONFIG_CODE }],
      },
      extension: [{ url: UI_ODOS_SCHEDULING_CONFIG_EXTENSION_URL, valueString: "{" }],
    },
  ] as const;

  for (const candidate of cases) {
    assert.throws(
      () => uiParseSchedulingPracticeConfig(candidate),
      (err) => {
        assert.ok(err instanceof Error);
        assert.throws(() => mcpParseSchedulingPracticeConfig(candidate), {
          message: err.message,
        });
        return true;
      },
    );
  }
});

test("UI scheduler practice-config mirror parse drops unknown forward-compat keys like the kernel", () => {
  const raw = JSON.stringify({ ...PRACTICE_CONFIG, futureKnob: { enabled: true } });
  const uiBasic = {
    resourceType: "Basic",
    code: {
      coding: [{ system: UI_ODOS_SCHEDULING_CONFIG_SYSTEM, code: UI_ODOS_SCHEDULING_CONFIG_CODE }],
    },
    extension: [{ url: UI_ODOS_SCHEDULING_CONFIG_EXTENSION_URL, valueString: raw }],
  } as const;
  const mcpBasic = {
    ...uiBasic,
    code: {
      coding: [{ system: MCP_ODOS_SCHEDULING_CONFIG_SYSTEM, code: MCP_ODOS_SCHEDULING_CONFIG_CODE }],
    },
    extension: [{ url: MCP_ODOS_SCHEDULING_CONFIG_EXTENSION_URL, valueString: raw }],
  } as const;

  assert.deepEqual(uiParseSchedulingPracticeConfig(uiBasic), mcpParseSchedulingPracticeConfig(mcpBasic));
  assert.equal("futureKnob" in uiParseSchedulingPracticeConfig(uiBasic), false);
});

test("UI catalog field build/parse pair matches the settings kernel", () => {
  const fields = [
    { type: "text", key: "label", label: "Label", required: true, unique: true },
    { type: "color", key: "color", label: "Color", palette: ["#4a7dff", "#44ddaa"] },
    { type: "duration", key: "duration", label: "Duration", min: 5, max: 120 },
    {
      type: "select",
      key: "kind",
      label: "Kind",
      options: [{ value: "house", label: "House" }],
    },
    { type: "reference-picker", key: "plan", label: "Plan" },
    { type: "toggle", key: "active", label: "Active" },
    { type: "weekly-hours", key: "hours", label: "Hours" },
    { type: "time-window-weekdays", key: "window", label: "Window" },
  ] as const satisfies readonly McpCatalogFieldDefinition[] & readonly UiCatalogFieldDefinition[];
  const item = {
    id: "fixture-1",
    label: "  Comprehensive  ",
    color: "#4a7dff",
    duration: 30,
    kind: "house",
    plan: "InsurancePlan/fixture-plan",
    active: true,
    hours: { mon: [{ start: "09:00", end: "17:00" }] },
    window: { weekdays: ["tue", "thu"], start: "10:00", end: "12:00" },
  };

  assert.deepEqual(uiParseCatalogFields(item, fields), mcpParseCatalogFields(item, fields));
  assert.deepEqual(
    uiBuildCatalogFields(item, fields, [], item.id),
    mcpBuildCatalogFields(item, fields, [], item.id),
  );
});

test("UI catalog field validation errors match the settings kernel verbatim", () => {
  const cases: Array<{ field: McpCatalogFieldDefinition & UiCatalogFieldDefinition; value: unknown }> = [
    { field: { type: "text", key: "value", label: "Label", required: true }, value: "" },
    { field: { type: "color", key: "value", label: "Color", palette: ["#4a7dff"] }, value: "#fff" },
    { field: { type: "number", key: "value", label: "Count", min: 1 }, value: 0 },
    { field: { type: "duration", key: "value", label: "Duration", min: 1 }, value: 12.5 },
    {
      field: { type: "select", key: "value", label: "Kind", options: [{ value: "a", label: "A" }] },
      value: "b",
    },
    { field: { type: "reference-picker", key: "value", label: "Plan" }, value: "not-a-reference" },
    { field: { type: "toggle", key: "value", label: "Active" }, value: "yes" },
    {
      field: { type: "weekly-hours", key: "value", label: "Hours" },
      value: { mon: [{ start: "17:00", end: "09:00" }] },
    },
    {
      field: { type: "time-window-weekdays", key: "value", label: "Window" },
      value: { weekdays: ["funday"] },
    },
  ];

  for (const { field, value } of cases) {
    assert.throws(
      () => uiBuildCatalogFields({ value }, [field]),
      (error) => {
        assert.ok(error instanceof Error);
        assert.throws(() => mcpBuildCatalogFields({ value }, [field]), { message: error.message });
        return true;
      },
    );
  }
});

test("UI scheduler mirror clinic-mode helpers match the kernel", () => {
  for (const mode of ["eyecare", "aesthetics", "both"]) {
    assert.deepEqual(uiDisciplinesForMode(mode), mcpDisciplinesForMode(mode));
    for (const discipline of ["eyecare", "aesthetics"]) {
      assert.equal(
        uiIsDisciplineVisible(discipline, mode),
        mcpIsDisciplineVisible(discipline, mode),
      );
    }
  }
});

test("UI scheduler mirror clinic-mode errors match the kernel verbatim", () => {
  assert.throws(
    () => uiDisciplinesForMode("surgery"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.throws(() => mcpDisciplinesForMode("surgery"), { message: err.message });
      return true;
    },
  );
  assert.throws(
    () => uiIsDisciplineVisible("surgery", "both"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.throws(() => mcpIsDisciplineVisible("surgery", "both"), { message: err.message });
      return true;
    },
  );
});

test("UI scheduler mirror visit-type readers match the kernel", () => {
  const visitType = buildVisitType({
    code: "special-testing",
    name: "Special Testing",
    discipline: "eyecare",
    durationMinutes: 30,
    color: "#cc88ff",
    eligibleResourceReferences: ["Device/oct-1", "Location/testing-room"],
    intakeFormReference: "Questionnaire/special-testing-intake",
  });

  assert.equal(uiVisitTypeCode(visitType), mcpVisitTypeCode(visitType));
  assert.equal(uiVisitTypeDiscipline(visitType), mcpVisitTypeDiscipline(visitType));
  assert.equal(uiVisitTypeDurationMinutes(visitType), mcpVisitTypeDurationMinutes(visitType));
  assert.equal(uiVisitTypeColor(visitType), mcpVisitTypeColor(visitType));
  assert.deepEqual(
    uiVisitTypeEligibleResourceReferences(visitType),
    mcpVisitTypeEligibleResourceReferences(visitType),
  );
});

test("UI scheduler mirror resource readers match the kernel", () => {
  const schedule = buildSchedulingResource({
    kind: "provider",
    actorReference: "Practitioner/bang-eric",
    actorDisplay: "Bang, Eric",
    disciplines: ["eyecare", "aesthetics"],
  });

  assert.deepEqual(uiResourceDisciplines(schedule), mcpResourceDisciplines(schedule));
  assert.equal(uiResourceKind(schedule), mcpResourceKind(schedule));
  assert.equal(uiIsResourceVisibleInMode(schedule, "eyecare"), mcpIsResourceVisibleInMode(schedule, "eyecare"));
  assert.equal(
    uiIsResourceVisibleInMode(schedule, "aesthetics"),
    mcpIsResourceVisibleInMode(schedule, "aesthetics"),
  );
});

test("UI scheduler mirror appointment readers match the kernel", () => {
  const appointment = buildSchedulingAppointment({
    patient: { reference: "Patient/p1", display: "Doe, Jane" },
    visitTypeCode: "routine-exam-new",
    visitTypeDisplay: "Routine Exam (New)",
    discipline: "eyecare",
    resources: [{ reference: "Practitioner/bang-eric", display: "Bang, Eric" }],
    start: "2026-07-08T09:00:00-05:00",
    durationMinutes: 30,
    status: "walk-in",
    confirmation: "confirmed",
    visionCoverage: { reference: "Coverage/vsp-1", display: "VSP" },
    medicalCoverage: { reference: "Coverage/bcbs-1", display: "BCBS" },
    urgent: true,
    followUp: true,
  });

  assert.equal(uiAppointmentVisitTypeCode(appointment), mcpAppointmentVisitTypeCode(appointment));
  assert.equal(uiConfirmationStatusOf(appointment), mcpConfirmationStatusOf(appointment));
  assert.equal(uiOdosAppointmentStatusOf(appointment), mcpOdosAppointmentStatusOf(appointment));
  assert.deepEqual(uiVisionCoverageOf(appointment), mcpVisionCoverageOf(appointment));
  assert.deepEqual(uiMedicalCoverageOf(appointment), mcpMedicalCoverageOf(appointment));
  assert.equal(uiIsUrgentAppointment(appointment), mcpIsUrgentAppointment(appointment));
  assert.equal(uiIsFollowUpAppointment(appointment), mcpIsFollowUpAppointment(appointment));
});

test("UI scheduler mirror Appointment builder matches the kernel output", () => {
  const input = {
    patient: { reference: "Patient/p1", display: "Doe, Jane" },
    visitTypeCode: "routine-exam-new",
    visitTypeDisplay: "Routine Exam (New)",
    discipline: "eyecare",
    resources: [{ reference: "Practitioner/bang-eric", display: "Bang, Eric" }],
    start: "2026-07-08T09:00:00-05:00",
    durationMinutes: 30,
    status: "walk-in",
    confirmation: "confirmed",
    visionCoverage: { reference: "Coverage/vsp-1", display: "VSP" },
    medicalCoverage: { reference: "Coverage/bcbs-1", display: "BCBS" },
    notes: "Prefers morning",
    urgent: true,
    followUp: true,
    created: "2026-07-06T14:00:00-05:00",
  } as const;

  assert.deepEqual(uiBuildSchedulingAppointment(input), buildSchedulingAppointment(input));
});

test("UI scheduler mirror Appointment builder errors match the kernel verbatim", () => {
  assert.throws(
    () =>
      uiBuildSchedulingAppointment({
        visitTypeCode: "routine-exam-new",
        discipline: "eyecare",
        resources: [{ reference: "Practitioner/bang-eric" }],
        start: "2026-07-08T09:00:00-05:00",
        durationMinutes: 30,
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.throws(
        () =>
          buildSchedulingAppointment({
            visitTypeCode: "routine-exam-new",
            discipline: "eyecare",
            resources: [{ reference: "Practitioner/bang-eric" }],
            start: "2026-07-08T09:00:00-05:00",
            durationMinutes: 30,
          }),
        { message: err.message },
      );
      return true;
    },
  );
});

test("UI scheduler booking validator mirrors kernel service validation order and messages", () => {
  const catalog = defaultMirrorCatalog();
  const resources = defaultMirrorResources();
  const existing: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p0" },
      visitTypeCode: "routine-exam-established",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }],
      start: "2026-07-08T09:00:00-05:00",
      durationMinutes: 30,
    }),
    id: "appt-existing",
  };

  assert.throws(
    () =>
      uiValidateAndBuildSchedulingAppointment({
        clinicMode: "both",
        visitTypes: catalog,
        resources,
        appointments: [],
        input: {
          patient: { reference: "Patient/p1" },
          visitTypeCode: "unicorn-exam",
          resourceScheduleReferences: ["Schedule/sch-provider"],
          start: "2026-07-08T09:00:00-05:00",
        },
        now: () => "2026-07-06T14:00:00-05:00",
      }),
    { message: 'Unknown visit type "unicorn-exam" — not in the active catalog.' },
  );
  assert.throws(
    () =>
      uiValidateAndBuildSchedulingAppointment({
        clinicMode: "eyecare",
        visitTypes: catalog,
        resources,
        appointments: [],
        input: {
          patient: { reference: "Patient/p1" },
          visitTypeCode: "aesthetics-consult",
          resourceScheduleReferences: ["Schedule/sch-room"],
          start: "2026-07-08T09:00:00-05:00",
        },
        now: () => "2026-07-06T14:00:00-05:00",
      }),
    {
      message:
        'Visit type "aesthetics-consult" is not available under this practice\'s clinic mode ("eyecare").',
    },
  );
  assert.throws(
    () =>
      uiValidateAndBuildSchedulingAppointment({
        clinicMode: "both",
        visitTypes: catalog,
        resources,
        appointments: [existing],
        input: {
          patient: { reference: "Patient/p1" },
          visitTypeCode: "routine-exam-new",
          resourceScheduleReferences: ["Schedule/sch-provider"],
          start: "2026-07-08T09:15:00-05:00",
        },
        now: () => "2026-07-06T14:00:00-05:00",
      }),
    {
      message:
        'Resource Practitioner/bang-eric is already booked over 2026-07-08T09:15:00-05:00 (conflict with Appointment/appt-existing). Pass allowDoubleBook to overbook.',
    },
  );
});

test("UI scheduler validator treats non-blocking resulting appointments as conflict-free", () => {
  const catalog = defaultMirrorCatalog();
  const resources = defaultMirrorResources();
  const existing: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p0" },
      visitTypeCode: "routine-exam-established",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }],
      start: "2026-07-08T09:00:00-05:00",
      durationMinutes: 30,
    }),
    id: "appt-existing",
  };

  const cancelled = uiValidateAndBuildSchedulingAppointment({
    clinicMode: "both",
    visitTypes: catalog,
    resources,
    appointments: [existing],
    input: {
      patient: { reference: "Patient/p1" },
      visitTypeCode: "routine-exam-new",
      resourceScheduleReferences: ["Schedule/sch-provider"],
      start: "2026-07-08T09:15:00-05:00",
      status: "cancelled",
    },
    now: () => "2026-07-06T14:00:00-05:00",
  });

  assert.equal(cancelled.status, "cancelled");
});

test("UI scheduler mirror appointment status reader matches non-walk-in kernel cases", () => {
  const cases = [
    { status: "arrived" as const, expected: "checked-in" },
    { status: "fulfilled" as const, expected: "checked-out" },
  ];
  for (const entry of cases) {
    assert.equal(uiOdosAppointmentStatusOf(entry), entry.expected);
    assert.equal(uiOdosAppointmentStatusOf(entry), mcpOdosAppointmentStatusOf(entry));
  }
});

test("UI visit-type display color owns the full palette fallback chain", () => {
  const explicitColor = buildVisitType({
    code: "branded",
    name: "Branded Visit",
    discipline: "eyecare",
    durationMinutes: 30,
    color: MCP_SCHEDULER_PALETTE.officeVisitOrange,
  });
  const colorlessAesthetics: HealthcareService = {
    resourceType: "HealthcareService",
    category: [{ coding: [{ system: MCP_ODOS_DISCIPLINE_SYSTEM, code: "aesthetics" }] }],
  };
  const noDiscipline: HealthcareService = { resourceType: "HealthcareService" };

  assert.equal(uiVisitTypeDisplayColor(explicitColor), MCP_SCHEDULER_PALETTE.officeVisitOrange);
  assert.equal(uiVisitTypeDisplayColor(colorlessAesthetics), MCP_SCHEDULER_PALETTE.aestheticsCyan);
  assert.equal(uiVisitTypeDisplayColor(noDiscipline), MCP_SCHEDULER_PALETTE.newExamBlue);
});

test("UI scheduler mirror blocked-time reader matches the kernel", () => {
  const slots = generateSlots({
    scheduleReference: "Schedule/sch-1",
    weeklyHours: { mon: [{ start: "11:00", end: "14:00" }] },
    slotMinutes: 30,
    from: "2026-07-06",
    to: "2026-07-06",
    timezoneOffset: "-05:00",
    blocks: [{ kind: "custom", description: "Rep lunch", weekdays: ["mon"], start: "12:00", end: "13:00" }],
  });
  const blocked = slots.find((slot) => slot.status === "busy-unavailable");
  assert.ok(blocked);
  assert.equal(uiBlockedTimeKindOf(blocked), mcpBlockedTimeKindOf(blocked));
});
