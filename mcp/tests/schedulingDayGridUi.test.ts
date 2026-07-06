import assert from "node:assert/strict";
import { test } from "node:test";
import type { HealthcareService, Patient, Schedule } from "@medplum/fhirtypes";
import { buildSchedulingAppointment } from "../src/fhir/schedulingAppointment.js";
import { buildSchedulingResource } from "../src/fhir/schedulingResource.js";
import { OSOD_DISCIPLINE_SYSTEM } from "../src/scheduling/clinic-mode.js";
import { defaultVisitTypeCatalog } from "../src/fhir/schedulingVisitType.js";
import {
  SCHEDULER_PALETTE,
  appointmentGeometry,
  availabilityShadingForColumn,
  blocksForSchedule,
  buildAppointmentBlockContent,
  buildTimeAxis,
  scheduleReference,
  visitTypeDisplayColor,
  visibleAppointmentsForMode,
  visibleSchedulingResources,
  visibleSchedulingVisitTypes,
  type SchedulingPracticeConfig,
} from "../../ui/src/lib/scheduling.js";
import {
  appointmentModalDraftFromAppointment,
  defaultAppointmentModalDraft,
  maskedSsnLast4,
  patientQuickCardViewModel,
} from "../../ui/src/lib/scheduler-appointment-ui.js";

const MONDAY = "2026-07-06";

function provider(id: string, actorReference: string, disciplines: string[], actorDisplay = actorReference): Schedule {
  return {
    ...buildSchedulingResource({
      kind: "provider",
      actorReference,
      actorDisplay,
      disciplines,
    }),
    id,
  };
}

test("day-grid filters resource columns and legend visit types by clinic mode without reordering", () => {
  const resources = [
    provider("sch-od", "Practitioner/od", ["eyecare"], "OD"),
    provider("sch-aesthetics", "Practitioner/aes", ["aesthetics"], "Aesthetics"),
    provider("sch-shared", "Practitioner/shared", ["eyecare", "aesthetics"], "Shared"),
  ];
  const catalog = defaultVisitTypeCatalog("both");

  assert.deepEqual(
    visibleSchedulingResources(resources, "eyecare").map((schedule) => schedule.id),
    ["sch-od", "sch-shared"],
  );
  assert.deepEqual(
    visibleSchedulingResources(resources, "aesthetics").map((schedule) => schedule.id),
    ["sch-aesthetics", "sch-shared"],
  );
  assert.ok(
    visibleSchedulingVisitTypes(catalog, "eyecare").every(
      (visitType) => !visitType.name?.startsWith("Aesthetics"),
    ),
  );
  assert.ok(
    visibleSchedulingVisitTypes(catalog, "both").length >
      visibleSchedulingVisitTypes(catalog, "eyecare").length,
  );
});

test("time axis comes from the union of operating windows and pads to whole hours", () => {
  const resources = [
    provider("sch-od", "Practitioner/od", ["eyecare"]),
    provider("sch-aesthetics", "Practitioner/aes", ["aesthetics"]),
  ];
  const config: SchedulingPracticeConfig = {
    timezoneOffset: "-05:00",
    defaultWeeklyHours: {},
    weeklyHoursBySchedule: {
      "Schedule/sch-od": { mon: [{ start: "08:15", end: "12:45" }] },
      "Schedule/sch-aesthetics": { mon: [{ start: "10:00", end: "17:10" }] },
    },
    blocks: [],
  };

  const axis = buildTimeAxis({ date: MONDAY, resources, config, slotMinutes: 30 });
  assert.equal(axis.startMinutes, 8 * 60);
  assert.equal(axis.endMinutes, 18 * 60);
  assert.equal(axis.rows.length, 20);
  assert.equal(axis.rows[0]?.label, "8:00 AM");
  assert.equal(axis.rows.at(-1)?.startMinutes, 17 * 60 + 30);
});

test("appointment geometry maps actor, wall-clock start, and duration onto column and row offsets", () => {
  const resources = [
    provider("sch-od", "Practitioner/od", ["eyecare"]),
    provider("sch-aesthetics", "Practitioner/aes", ["aesthetics"]),
  ];
  const appointment = buildSchedulingAppointment({
    patient: { reference: "Patient/p1", display: "Doe, Jane" },
    visitTypeCode: "routine-exam-new",
    discipline: "eyecare",
    resources: [{ reference: "Practitioner/aes" }],
    start: "2026-07-06T09:15:00-05:00",
    durationMinutes: 45,
  });

  assert.deepEqual(
    appointmentGeometry({
      appointment,
      resources,
      axisStartMinutes: 8 * 60,
      slotMinutes: 30,
      timezoneOffset: "-05:00",
    }),
    [{
      columnIndex: 1,
      rowStart: 2.5,
      rowSpan: 1.5,
    }],
  );
});

test("appointment geometry places UTC instants in practice-local rows", () => {
  const resources = [provider("sch-od", "Practitioner/od", ["eyecare"])];
  const appointment = buildSchedulingAppointment({
    patient: { reference: "Patient/p1", display: "Doe, Jane" },
    visitTypeCode: "routine-exam-new",
    discipline: "eyecare",
    resources: [{ reference: "Practitioner/od" }],
    start: "2026-07-06T14:00:00Z",
    durationMinutes: 30,
  });

  assert.deepEqual(
    appointmentGeometry({
      appointment,
      resources,
      axisStartMinutes: 8 * 60,
      slotMinutes: 30,
      timezoneOffset: "-05:00",
    }),
    [{ columnIndex: 0, rowStart: 2, rowSpan: 1 }],
  );
});

test("appointment geometry emits one block for every booked resource column", () => {
  const resources = [
    provider("sch-od", "Practitioner/od", ["eyecare"]),
    {
      ...buildSchedulingResource({
        kind: "room",
        actorReference: "Location/exam-1",
        actorDisplay: "Exam 1",
        disciplines: ["eyecare"],
      }),
      id: "sch-room",
    },
  ];
  const appointment = buildSchedulingAppointment({
    patient: { reference: "Patient/p1", display: "Doe, Jane" },
    visitTypeCode: "routine-exam-new",
    discipline: "eyecare",
    resources: [{ reference: "Practitioner/od" }, { reference: "Location/exam-1" }],
    start: "2026-07-06T09:00:00-05:00",
    durationMinutes: 30,
  });

  assert.deepEqual(
    appointmentGeometry({
      appointment,
      resources,
      axisStartMinutes: 8 * 60,
      slotMinutes: 30,
      timezoneOffset: "-05:00",
    }).map((geometry) => geometry.columnIndex),
    [0, 1],
  );
});

test("availability shading marks outside hours, in-hours, and blocked regions per column", () => {
  const regions = availabilityShadingForColumn({
    date: MONDAY,
    axisStartMinutes: 8 * 60,
    axisEndMinutes: 13 * 60,
    slotMinutes: 30,
    weeklyHours: { mon: [{ start: "09:00", end: "12:00" }] },
    blocks: [{ kind: "custom", description: "Rep lunch", date: MONDAY, start: "10:00", end: "10:30" }],
  });

  assert.deepEqual(
    regions.map((region) => [region.kind, region.startMinutes, region.endMinutes]),
    [
      ["outside-hours", 480, 540],
      ["in-hours", 540, 720],
      ["outside-hours", 720, 780],
      ["blocked", 600, 630],
    ],
  );
  assert.equal(regions[3]?.rowStart, 4);
  assert.equal(regions[3]?.rowSpan, 1);
  assert.equal(regions[3]?.blockedKind, "custom");
  assert.equal(regions[3]?.description, "Rep lunch");
});

test("blocks can scope to one schedule without shading every resource column", () => {
  const resourceA = provider("sch-a", "Practitioner/a", ["eyecare"]);
  const resourceB = provider("sch-b", "Practitioner/b", ["eyecare"]);
  const config: SchedulingPracticeConfig = {
    timezoneOffset: "-05:00",
    defaultWeeklyHours: { mon: [{ start: "08:00", end: "12:00" }] },
    weeklyHoursBySchedule: {},
    blocks: [
      { kind: "custom", description: "Lunch", weekdays: ["mon"], start: "12:00", end: "13:00" },
      {
        kind: "staff-off",
        description: "OD out",
        date: MONDAY,
        start: "09:00",
        end: "10:00",
        scheduleReferences: ["Schedule/sch-a"],
      },
    ],
  };

  assert.deepEqual(
    blocksForSchedule(config, resourceA).map((block) => block.description),
    ["Lunch", "OD out"],
  );
  assert.deepEqual(
    blocksForSchedule(config, resourceB).map((block) => block.description),
    ["Lunch"],
  );
});

test("appointment content assembly renders patient, visit type, status axes, insurance, and badges", () => {
  const catalog = defaultVisitTypeCatalog("both");
  const appointment = buildSchedulingAppointment({
    patient: { reference: "Patient/p1", display: "Doe, Jane" },
    visitTypeCode: "routine-exam-new",
    visitTypeDisplay: "Routine Exam (New)",
    discipline: "eyecare",
    resources: [{ reference: "Practitioner/od" }],
    start: "2026-07-06T09:00:00-05:00",
    durationMinutes: 30,
    status: "walk-in",
    confirmation: "confirmed",
    visionCoverage: { display: "VSP" },
    medicalCoverage: { display: "BCBS" },
    urgent: true,
    followUp: true,
  });

  const content = buildAppointmentBlockContent(appointment, catalog);
  assert.equal(content.patientDisplay, "Doe, Jane");
  assert.equal(content.visitTypeDisplay, "Routine Exam (New)");
  assert.equal(content.color, SCHEDULER_PALETTE.newExamBlue);
  assert.equal(content.statusDisplay, "Walk In");
  assert.equal(content.confirmationDisplay, "Confirmed");
  assert.equal(content.insuranceLine, "Vision: VSP · Medical: BCBS");
  assert.deepEqual(content.badges.map((badge) => badge.code), ["urgent", "follow-up", "walk-in"]);
});

test("non-patient appointments render as gold blocks and hidden-discipline appointments drop out of eyecare mode", () => {
  const catalog = defaultVisitTypeCatalog("both");
  const staffMeeting = buildSchedulingAppointment({
    description: "Staff meeting",
    visitTypeCode: "non-patient",
    discipline: "eyecare",
    resources: [{ reference: "Practitioner/od" }],
    start: "2026-07-06T12:00:00-05:00",
    durationMinutes: 60,
  });
  const aesthetics = buildSchedulingAppointment({
    patient: { reference: "Patient/p2", display: "Aesthetic Patient" },
    visitTypeCode: "aesthetics-consult",
    discipline: "aesthetics",
    resources: [{ reference: "Practitioner/shared" }],
    start: "2026-07-06T13:00:00-05:00",
    durationMinutes: 30,
  });

  assert.equal(buildAppointmentBlockContent(staffMeeting, catalog).color, SCHEDULER_PALETTE.nonPatientGold);
  assert.deepEqual(buildAppointmentBlockContent(staffMeeting, catalog).badges.map((badge) => badge.code), [
    "non-patient",
  ]);
  assert.deepEqual(visibleAppointmentsForMode([staffMeeting, aesthetics], "eyecare"), [staffMeeting]);
  assert.deepEqual(visibleAppointmentsForMode([staffMeeting, aesthetics], "both"), [staffMeeting, aesthetics]);
  assert.equal(scheduleReference(provider("sch-od", "Practitioner/od", ["eyecare"])), "Schedule/sch-od");
});

test("cancelled and entered-in-error appointments do not occupy visible grid slots", () => {
  const live = buildSchedulingAppointment({
    patient: { reference: "Patient/live", display: "Live Patient" },
    visitTypeCode: "routine-exam-new",
    discipline: "eyecare",
    resources: [{ reference: "Practitioner/od" }],
    start: "2026-07-06T09:00:00-05:00",
    durationMinutes: 30,
    status: "scheduled",
  });
  const cancelled = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/cancelled", display: "Cancelled Patient" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/od" }],
      start: "2026-07-06T09:00:00-05:00",
      durationMinutes: 30,
      status: "cancelled",
    }),
    id: "cancelled",
  };
  const enteredInError = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/error", display: "Error Patient" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/od" }],
      start: "2026-07-06T09:00:00-05:00",
      durationMinutes: 30,
      status: "scheduled",
    }),
    id: "entered-in-error",
    status: "entered-in-error" as const,
  };

  assert.deepEqual(
    visibleAppointmentsForMode([cancelled, enteredInError, live], "eyecare").map((appointment) => appointment.id),
    [live.id],
  );
});

test("visit type display color falls back through discipline defaults before new-exam blue", () => {
  const aestheticsNoColor: HealthcareService = {
    resourceType: "HealthcareService",
    active: true,
    category: [{ coding: [{ system: OSOD_DISCIPLINE_SYSTEM, code: "aesthetics" }] }],
  };
  const noDisciplineNoColor: HealthcareService = {
    resourceType: "HealthcareService",
    active: true,
  };

  assert.equal(visitTypeDisplayColor(aestheticsNoColor), SCHEDULER_PALETTE.aestheticsCyan);
  assert.equal(visitTypeDisplayColor(noDisciplineNoColor), SCHEDULER_PALETTE.newExamBlue);
});

test("default appointment modal draft uses the clicked resource, time, catalog duration, and walk-in override", () => {
  const catalog = defaultVisitTypeCatalog("both");
  const resources = [provider("sch-od", "Practitioner/od", ["eyecare"], "OD")];

  const draft = defaultAppointmentModalDraft({
    date: MONDAY,
    startMinutes: 9 * 60,
    timezoneOffset: "-05:00",
    resources,
    visitTypes: catalog,
    clinicMode: "both",
    resource: resources[0]!,
    status: "walk-in",
  });

  assert.equal(draft.start, "2026-07-06T09:00:00-05:00");
  assert.equal(draft.visitTypeCode, "routine-exam-new");
  assert.equal(draft.durationMinutes, 30);
  assert.deepEqual(draft.resourceScheduleReferences, ["Schedule/sch-od"]);
  assert.equal(draft.status, "walk-in");
});

test("appointment modal draft round-trips editable Eyefinity fields from an existing block", () => {
  const appointment = buildSchedulingAppointment({
    patient: { reference: "Patient/p1", display: "Doe, Jane" },
    visitTypeCode: "routine-exam-new",
    discipline: "eyecare",
    resources: [{ reference: "Practitioner/od" }],
    start: "2026-07-06T09:00:00-05:00",
    durationMinutes: 30,
    confirmation: "confirmed",
    visionCoverage: { display: "VSP" },
    medicalCoverage: { display: "BCBS" },
    notes: "Bring trial frame",
    urgent: true,
    followUp: true,
  });
  const resources = [provider("sch-od", "Practitioner/od", ["eyecare"], "OD")];

  const draft = appointmentModalDraftFromAppointment(appointment, resources);

  assert.equal(draft.patient?.reference, "Patient/p1");
  assert.equal(draft.nonPatient, false);
  assert.equal(draft.confirmation, "confirmed");
  assert.equal(draft.visionCoverageDisplay, "VSP");
  assert.equal(draft.medicalCoverageDisplay, "BCBS");
  assert.equal(draft.notes, "Bring trial frame");
  assert.equal(draft.urgent, true);
  assert.equal(draft.followUp, true);
});

test("quick-card view model masks SSN to last four and never returns the raw identifier", () => {
  const patient: Patient = {
    resourceType: "Patient",
    id: "p1",
    name: [{ given: ["Jane"], family: "Doe" }],
    birthDate: "1980-01-02",
    gender: "female",
    identifier: [
      { type: { coding: [{ code: "MR" }] }, value: "MRN-123" },
      { system: "http://hl7.org/fhir/sid/us-ssn", value: "123-45-6789" },
    ],
  };

  assert.equal(maskedSsnLast4(patient), "***-**-6789");
  assert.equal(maskedSsnLast4(patient)?.includes("123-45"), false);
  assert.deepEqual(patientQuickCardViewModel({ patient, onDate: "2026-07-06" }), {
    name: "Jane Doe",
    birthDate: "1980-01-02",
    age: 46,
    birthSex: "female",
    phones: [],
    emails: [],
    address: "none",
    mrn: "MRN-123",
    ssnLast4: "***-**-6789",
    provider: "none",
  });
});
