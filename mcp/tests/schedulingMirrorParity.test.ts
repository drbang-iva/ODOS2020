import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment, HealthcareService, Schedule } from "@medplum/fhirtypes";
import {
  CLINIC_MODES as MCP_CLINIC_MODES,
  OSOD_DISCIPLINE_SYSTEM as MCP_OSOD_DISCIPLINE_SYSTEM,
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
  OSOD_DISPLAY_COLOR_EXTENSION_URL as MCP_OSOD_DISPLAY_COLOR_EXTENSION_URL,
  OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL as MCP_OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL,
  OSOD_INTAKE_FORM_EXTENSION_URL as MCP_OSOD_INTAKE_FORM_EXTENSION_URL,
  OSOD_VISIT_DURATION_EXTENSION_URL as MCP_OSOD_VISIT_DURATION_EXTENSION_URL,
  OSOD_VISIT_TYPE_SYSTEM as MCP_OSOD_VISIT_TYPE_SYSTEM,
  SCHEDULER_PALETTE as MCP_SCHEDULER_PALETTE,
  buildVisitType,
  defaultVisitTypeCatalog,
  visitTypeCode as mcpVisitTypeCode,
  visitTypeColor as mcpVisitTypeColor,
  visitTypeDiscipline as mcpVisitTypeDiscipline,
  visitTypeDurationMinutes as mcpVisitTypeDurationMinutes,
  visitTypeEligibleResourceReferences as mcpVisitTypeEligibleResourceReferences,
} from "../src/fhir/schedulingVisitType.js";
import {
  APPOINTMENT_CONFIRMATION_STATUSES as MCP_APPOINTMENT_CONFIRMATION_STATUSES,
  OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL as MCP_OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
  OSOD_APPOINTMENT_CONFIRMATION_SYSTEM as MCP_OSOD_APPOINTMENT_CONFIRMATION_SYSTEM,
  confirmationStatusOf as mcpConfirmationStatusOf,
} from "../src/fhir/appointmentConfirmation.js";
import {
  OSOD_APPOINTMENT_STATUSES as MCP_OSOD_APPOINTMENT_STATUSES,
  V2_0276_APPOINTMENT_TYPE_SYSTEM as MCP_V2_0276_APPOINTMENT_TYPE_SYSTEM,
  osodAppointmentStatusOf as mcpOsodAppointmentStatusOf,
} from "../src/fhir/schedulingAppointmentStatus.js";
import {
  OSOD_FOLLOW_UP_EXTENSION_URL as MCP_OSOD_FOLLOW_UP_EXTENSION_URL,
  OSOD_MEDICAL_COVERAGE_EXTENSION_URL as MCP_OSOD_MEDICAL_COVERAGE_EXTENSION_URL,
  OSOD_VISION_COVERAGE_EXTENSION_URL as MCP_OSOD_VISION_COVERAGE_EXTENSION_URL,
  appointmentVisitTypeCode as mcpAppointmentVisitTypeCode,
  buildSchedulingAppointment,
  isFollowUpAppointment as mcpIsFollowUpAppointment,
  isUrgentAppointment as mcpIsUrgentAppointment,
  medicalCoverageOf as mcpMedicalCoverageOf,
  visionCoverageOf as mcpVisionCoverageOf,
} from "../src/fhir/schedulingAppointment.js";
import {
  BLOCKED_TIME_KINDS as MCP_BLOCKED_TIME_KINDS,
  OSOD_BLOCKED_TIME_KIND_EXTENSION_URL as MCP_OSOD_BLOCKED_TIME_KIND_EXTENSION_URL,
  OSOD_BLOCKED_TIME_KIND_SYSTEM as MCP_OSOD_BLOCKED_TIME_KIND_SYSTEM,
  blockedTimeKindOf as mcpBlockedTimeKindOf,
  generateSlots,
} from "../src/scheduling/availability.js";
import {
  APPOINTMENT_CONFIRMATION_STATUSES as UI_APPOINTMENT_CONFIRMATION_STATUSES,
  BLOCKED_TIME_KINDS as UI_BLOCKED_TIME_KINDS,
  CLINIC_MODES as UI_CLINIC_MODES,
  DISCIPLINE_COLOR_BANDS as UI_DISCIPLINE_COLOR_BANDS,
  OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL as UI_OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
  OSOD_APPOINTMENT_CONFIRMATION_SYSTEM as UI_OSOD_APPOINTMENT_CONFIRMATION_SYSTEM,
  OSOD_APPOINTMENT_STATUSES as UI_OSOD_APPOINTMENT_STATUSES,
  OSOD_BLOCKED_TIME_KIND_EXTENSION_URL as UI_OSOD_BLOCKED_TIME_KIND_EXTENSION_URL,
  OSOD_BLOCKED_TIME_KIND_SYSTEM as UI_OSOD_BLOCKED_TIME_KIND_SYSTEM,
  OSOD_DISCIPLINE_SYSTEM as UI_OSOD_DISCIPLINE_SYSTEM,
  OSOD_DISPLAY_COLOR_EXTENSION_URL as UI_OSOD_DISPLAY_COLOR_EXTENSION_URL,
  OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL as UI_OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL,
  OSOD_FOLLOW_UP_EXTENSION_URL as UI_OSOD_FOLLOW_UP_EXTENSION_URL,
  OSOD_INTAKE_FORM_EXTENSION_URL as UI_OSOD_INTAKE_FORM_EXTENSION_URL,
  OSOD_MEDICAL_COVERAGE_EXTENSION_URL as UI_OSOD_MEDICAL_COVERAGE_EXTENSION_URL,
  OSOD_VISION_COVERAGE_EXTENSION_URL as UI_OSOD_VISION_COVERAGE_EXTENSION_URL,
  OSOD_VISIT_DURATION_EXTENSION_URL as UI_OSOD_VISIT_DURATION_EXTENSION_URL,
  OSOD_VISIT_TYPE_SYSTEM as UI_OSOD_VISIT_TYPE_SYSTEM,
  NON_BLOCKING_APPOINTMENT_STATUSES as UI_NON_BLOCKING_APPOINTMENT_STATUSES,
  RESOURCE_KINDS as UI_RESOURCE_KINDS,
  SCHEDULER_PALETTE as UI_SCHEDULER_PALETTE,
  SCHEDULING_DISCIPLINES as UI_SCHEDULING_DISCIPLINES,
  V2_0276_APPOINTMENT_TYPE_SYSTEM as UI_V2_0276_APPOINTMENT_TYPE_SYSTEM,
  appointmentVisitTypeCode as uiAppointmentVisitTypeCode,
  blockedTimeKindOf as uiBlockedTimeKindOf,
  buildSchedulingAppointment as uiBuildSchedulingAppointment,
  confirmationStatusOf as uiConfirmationStatusOf,
  disciplinesForMode as uiDisciplinesForMode,
  isDisciplineVisible as uiIsDisciplineVisible,
  isFollowUpAppointment as uiIsFollowUpAppointment,
  isResourceVisibleInMode as uiIsResourceVisibleInMode,
  isUrgentAppointment as uiIsUrgentAppointment,
  medicalCoverageOf as uiMedicalCoverageOf,
  osodAppointmentStatusOf as uiOsodAppointmentStatusOf,
  validateAndBuildSchedulingAppointment as uiValidateAndBuildSchedulingAppointment,
  resourceDisciplines as uiResourceDisciplines,
  resourceKind as uiResourceKind,
  visitTypeCode as uiVisitTypeCode,
  visitTypeColor as uiVisitTypeColor,
  visitTypeDiscipline as uiVisitTypeDiscipline,
  visitTypeDisplayColor as uiVisitTypeDisplayColor,
  visitTypeDurationMinutes as uiVisitTypeDurationMinutes,
  visitTypeEligibleResourceReferences as uiVisitTypeEligibleResourceReferences,
  visionCoverageOf as uiVisionCoverageOf,
} from "../../ui/src/lib/scheduling.js";

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

test("UI scheduler mirror constants match the Phase-1 kernel", () => {
  assert.deepEqual(UI_CLINIC_MODES, MCP_CLINIC_MODES);
  assert.deepEqual(UI_SCHEDULING_DISCIPLINES, MCP_SCHEDULING_DISCIPLINES);
  assert.equal(UI_OSOD_DISCIPLINE_SYSTEM, MCP_OSOD_DISCIPLINE_SYSTEM);
  assert.deepEqual(UI_RESOURCE_KINDS, MCP_RESOURCE_KINDS);
  assert.equal(UI_OSOD_VISIT_TYPE_SYSTEM, MCP_OSOD_VISIT_TYPE_SYSTEM);
  assert.equal(UI_OSOD_VISIT_DURATION_EXTENSION_URL, MCP_OSOD_VISIT_DURATION_EXTENSION_URL);
  assert.equal(UI_OSOD_DISPLAY_COLOR_EXTENSION_URL, MCP_OSOD_DISPLAY_COLOR_EXTENSION_URL);
  assert.equal(UI_OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL, MCP_OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL);
  assert.equal(UI_OSOD_INTAKE_FORM_EXTENSION_URL, MCP_OSOD_INTAKE_FORM_EXTENSION_URL);
  assert.deepEqual(UI_SCHEDULER_PALETTE, MCP_SCHEDULER_PALETTE);
  assert.deepEqual(UI_DISCIPLINE_COLOR_BANDS, MCP_DISCIPLINE_COLOR_BANDS);
  assert.equal(
    UI_OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
    MCP_OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
  );
  assert.equal(UI_OSOD_APPOINTMENT_CONFIRMATION_SYSTEM, MCP_OSOD_APPOINTMENT_CONFIRMATION_SYSTEM);
  assert.deepEqual(UI_APPOINTMENT_CONFIRMATION_STATUSES, MCP_APPOINTMENT_CONFIRMATION_STATUSES);
  assert.deepEqual(UI_OSOD_APPOINTMENT_STATUSES, MCP_OSOD_APPOINTMENT_STATUSES);
  assert.equal(UI_V2_0276_APPOINTMENT_TYPE_SYSTEM, MCP_V2_0276_APPOINTMENT_TYPE_SYSTEM);
  assert.equal(UI_OSOD_VISION_COVERAGE_EXTENSION_URL, MCP_OSOD_VISION_COVERAGE_EXTENSION_URL);
  assert.equal(UI_OSOD_MEDICAL_COVERAGE_EXTENSION_URL, MCP_OSOD_MEDICAL_COVERAGE_EXTENSION_URL);
  assert.equal(UI_OSOD_FOLLOW_UP_EXTENSION_URL, MCP_OSOD_FOLLOW_UP_EXTENSION_URL);
  assert.equal(UI_OSOD_BLOCKED_TIME_KIND_EXTENSION_URL, MCP_OSOD_BLOCKED_TIME_KIND_EXTENSION_URL);
  assert.equal(UI_OSOD_BLOCKED_TIME_KIND_SYSTEM, MCP_OSOD_BLOCKED_TIME_KIND_SYSTEM);
  assert.deepEqual(UI_BLOCKED_TIME_KINDS, MCP_BLOCKED_TIME_KINDS);
  assert.deepEqual(UI_NON_BLOCKING_APPOINTMENT_STATUSES, ["cancelled", "entered-in-error"]);
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
  assert.equal(uiOsodAppointmentStatusOf(appointment), mcpOsodAppointmentStatusOf(appointment));
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
    assert.equal(uiOsodAppointmentStatusOf(entry), entry.expected);
    assert.equal(uiOsodAppointmentStatusOf(entry), mcpOsodAppointmentStatusOf(entry));
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
    category: [{ coding: [{ system: MCP_OSOD_DISCIPLINE_SYSTEM, code: "aesthetics" }] }],
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
