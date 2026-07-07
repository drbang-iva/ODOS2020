import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment, HealthcareService, Schedule } from "@medplum/fhirtypes";
import { buildSchedulingResource } from "../src/fhir/schedulingResource.js";
import { buildVisitType } from "../src/fhir/schedulingVisitType.js";
import {
  appointmentDayBoundsParams,
  appointmentRangeBoundsParams,
  buildSchedulingAppointment,
  scheduleReference,
  type SchedulingPracticeConfig,
} from "../../ui/src/lib/scheduling.js";
import {
  addMonthsClamped,
  appointmentDraftForSchedulerCell,
  bucketAppointmentsByPracticeDay,
  formatSchedulerDateLabel,
  monthAppointmentSummaries,
  monthCalendarGrid,
  schedulerWindowForView,
  weekDays,
  weekStartYmd,
} from "../../ui/src/lib/scheduling-calendar.js";

function schedules(): Schedule[] {
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
        kind: "provider",
        actorReference: "Practitioner/smith-amy",
        actorDisplay: "Smith, Amy",
        disciplines: ["eyecare"],
      }),
      id: "sch-provider-2",
    },
    {
      ...buildSchedulingResource({
        kind: "provider",
        actorReference: "Practitioner/aesthetics",
        actorDisplay: "Aesthetics Provider",
        disciplines: ["aesthetics"],
      }),
      id: "sch-aesthetics",
    },
  ];
}

function routineVisitType(): HealthcareService {
  return {
    ...buildVisitType({
      code: "routine-exam-new",
      name: "Routine Exam (New)",
      discipline: "eyecare",
      durationMinutes: 30,
      color: "#123456",
    }),
    id: "vt-routine",
  };
}

function aestheticsVisitType(): HealthcareService {
  return {
    ...buildVisitType({
      code: "aesthetic-consult",
      name: "Aesthetic Consult",
      discipline: "aesthetics",
      durationMinutes: 30,
      color: "#abcdef",
    }),
    id: "vt-aesthetic",
  };
}

function config(): SchedulingPracticeConfig {
  return {
    timezoneOffset: "-05:00",
    defaultWeeklyHours: {
      mon: [{ start: "09:00", end: "17:00" }],
      tue: [{ start: "09:00", end: "17:00" }],
      wed: [{ start: "09:00", end: "17:00" }],
      thu: [{ start: "09:00", end: "17:00" }],
      fri: [{ start: "09:00", end: "17:00" }],
    },
    weeklyHoursBySchedule: {},
    blocks: [],
    offices: [
      { id: "main", name: "Main Office" },
      { id: "satellite", name: "Satellite" },
    ],
    officeBySchedule: {
      "Schedule/sch-provider": "main",
      "Schedule/sch-provider-2": "satellite",
      "Schedule/sch-aesthetics": "main",
    },
  };
}

function booked(input: {
  id: string;
  start: string;
  patientDisplay?: string;
  actorReference?: string;
  visitTypeCode?: string;
  discipline?: "eyecare" | "aesthetics";
  status?: Appointment["status"];
}): Appointment {
  const appointment = buildSchedulingAppointment({
    patient: { reference: `Patient/${input.id}`, display: input.patientDisplay ?? "Doe, Jane" },
    visitTypeCode: input.visitTypeCode ?? "routine-exam-new",
    discipline: input.discipline ?? "eyecare",
    resources: [{ reference: input.actorReference ?? "Practitioner/bang-eric" }],
    start: input.start,
    durationMinutes: 30,
  });
  return { ...appointment, id: input.id, status: input.status ?? appointment.status };
}

test("scheduler week and month math use Monday anchors and visible-grid windows", () => {
  assert.equal(weekStartYmd("2026-07-06"), "2026-07-06");
  assert.equal(weekStartYmd("2026-07-12"), "2026-07-06");
  assert.deepEqual(weekDays("2026-07-12"), [
    "2026-07-06",
    "2026-07-07",
    "2026-07-08",
    "2026-07-09",
    "2026-07-10",
    "2026-07-11",
    "2026-07-12",
  ]);
  assert.deepEqual(schedulerWindowForView("2026-07-09", "week"), {
    fromYmd: "2026-07-06",
    toYmdExclusive: "2026-07-13",
  });

  const compactMonth = monthCalendarGrid("2026-06-15");
  assert.equal(compactMonth.cells.length, 35);
  assert.equal(compactMonth.cells[0]?.date, "2026-06-01");
  assert.equal(compactMonth.cells.at(-1)?.date, "2026-07-05");

  const sixRowMonth = monthCalendarGrid("2026-08-15");
  assert.equal(sixRowMonth.cells.length, 42);
  assert.equal(sixRowMonth.cells[0]?.date, "2026-07-27");
  assert.equal(sixRowMonth.cells.at(-1)?.date, "2026-09-06");
  assert.deepEqual(schedulerWindowForView("2026-08-15", "month"), {
    fromYmd: "2026-07-27",
    toYmdExclusive: "2026-09-07",
  });
});

test("scheduler month navigation clamps end-of-month anchors and labels by active view", () => {
  assert.equal(addMonthsClamped("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsClamped("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonthsClamped("2026-03-31", -1), "2026-02-28");
  assert.equal(formatSchedulerDateLabel("2026-07-06", "day"), "Jul 6, 2026");
  assert.equal(formatSchedulerDateLabel("2026-07-08", "week"), "Jul 6 \u2013 Jul 12, 2026");
  assert.equal(formatSchedulerDateLabel("2026-07-08", "month"), "July 2026");
});

test("appointment range bounds generalize day bounds with practice timezone offsets", () => {
  assert.deepEqual(
    appointmentRangeBoundsParams("2026-07-06", "2026-07-13", "-05:00").getAll("date"),
    ["ge2026-07-06T00:00:00-05:00", "lt2026-07-13T00:00:00-05:00"],
  );
  assert.deepEqual(
    appointmentDayBoundsParams("2026-07-06", "-05:00").getAll("date"),
    appointmentRangeBoundsParams("2026-07-06", "2026-07-07", "-05:00").getAll("date"),
  );
});

test("appointment window bucketing uses practice-local dates", () => {
  const byDay = bucketAppointmentsByPracticeDay(
    [
      booked({ id: "late", start: "2026-07-07T01:30:00Z" }),
      booked({ id: "local", start: "2026-07-07T09:00:00-05:00" }),
    ],
    "-05:00",
  );

  assert.deepEqual(byDay["2026-07-06"]?.map((appointment) => appointment.id), ["late"]);
  assert.deepEqual(byDay["2026-07-07"]?.map((appointment) => appointment.id), ["local"]);
});

test("week empty-cell draft maps the clicked day, resource, and slot into the shared appointment draft", () => {
  const [resource] = schedules();
  assert.ok(resource);

  const draft = appointmentDraftForSchedulerCell({
    date: "2026-07-08",
    startMinutes: 10 * 60 + 30,
    timezoneOffset: "-05:00",
    resources: schedules(),
    visitTypes: [routineVisitType()],
    clinicMode: "eyecare",
    resource,
  });

  assert.equal(draft.start, "2026-07-08T10:30:00-05:00");
  assert.deepEqual(draft.resourceScheduleReferences, [scheduleReference(resource)]);
  assert.equal(draft.visitTypeCode, "routine-exam-new");
});

test("month summaries filter by office and mode, exclude non-blocking appointments, and cap chips", () => {
  const summaries = monthAppointmentSummaries({
    appointments: [
      booked({ id: "a-1", start: "2026-07-06T09:00:00-05:00", patientDisplay: "Alpha, Ann" }),
      booked({ id: "a-2", start: "2026-07-06T09:30:00-05:00", patientDisplay: "Baker, Ben" }),
      booked({ id: "a-3", start: "2026-07-06T10:00:00-05:00", patientDisplay: "Clark, Cam" }),
      booked({ id: "a-4", start: "2026-07-06T10:30:00-05:00", patientDisplay: "Delta, Dee" }),
      booked({
        id: "cancelled",
        start: "2026-07-06T11:00:00-05:00",
        patientDisplay: "Cancelled, Casey",
        status: "cancelled",
      }),
      booked({
        id: "satellite",
        start: "2026-07-06T11:30:00-05:00",
        patientDisplay: "Satellite, Sam",
        actorReference: "Practitioner/smith-amy",
      }),
      booked({
        id: "aesthetic",
        start: "2026-07-06T12:00:00-05:00",
        patientDisplay: "Aesthetic, Alex",
        actorReference: "Practitioner/aesthetics",
        visitTypeCode: "aesthetic-consult",
        discipline: "aesthetics",
      }),
    ],
    resources: schedules(),
    visitTypes: [routineVisitType(), aestheticsVisitType()],
    config: config(),
    clinicMode: "eyecare",
    officeId: "main",
    timezoneOffset: "-05:00",
    chipLimit: 3,
  });

  assert.deepEqual(
    summaries["2026-07-06"]?.chips.map((chip) => ({
      appointmentId: chip.appointmentId,
      time: chip.time,
      patientLastName: chip.patientLastName,
      color: chip.color,
    })),
    [
      { appointmentId: "a-1", time: "09:00", patientLastName: "Alpha", color: "#123456" },
      { appointmentId: "a-2", time: "09:30", patientLastName: "Baker", color: "#123456" },
      { appointmentId: "a-3", time: "10:00", patientLastName: "Clark", color: "#123456" },
    ],
  );
  assert.equal(summaries["2026-07-06"]?.hiddenCount, 1);
});
