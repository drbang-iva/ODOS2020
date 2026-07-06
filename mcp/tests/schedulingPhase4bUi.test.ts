import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment, HealthcareService, Schedule } from "@medplum/fhirtypes";
import { buildSchedulingResource } from "../src/fhir/schedulingResource.js";
import { buildVisitType } from "../src/fhir/schedulingVisitType.js";
import {
  availabilityShadingForColumn,
  buildSchedulingAppointment,
  findNextOpenings,
  findOpenSearchScopeKey,
  scheduleReference,
  visibleSchedulingResourcesForOffice,
  type SchedulingPracticeConfig,
} from "../../ui/src/lib/scheduling.js";
import {
  addSchedulingOffice,
  assignScheduleOffice,
  copyWeeklyHoursBetweenSchedules,
  removeSchedulingOffice,
  replaceSchedulingBlock,
  validateBlockScope,
  validateSchedulingPracticeSettings,
} from "../../ui/src/lib/scheduling-settings.js";

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
        kind: "room",
        actorReference: "Location/exam-1",
        actorDisplay: "Exam 1",
        disciplines: ["eyecare"],
      }),
      id: "sch-room",
    },
  ];
}

function routineVisitType(input: {
  durationMinutes?: number;
  eligibleResourceReferences?: string[];
} = {}): HealthcareService {
  return {
    ...buildVisitType({
      code: "routine-exam-new",
      name: "Routine Exam (New)",
      discipline: "eyecare",
      durationMinutes: input.durationMinutes ?? 30,
      eligibleResourceReferences: input.eligibleResourceReferences,
    }),
    id: "vt-routine",
  };
}

function config(): SchedulingPracticeConfig {
  return {
    timezoneOffset: "-05:00",
    defaultWeeklyHours: {
      mon: [{ start: "09:00", end: "11:00" }],
      tue: [{ start: "09:00", end: "11:00" }],
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
    },
  };
}

function booked(start: string, status: Appointment["status"] = "booked"): Appointment {
  return {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p1" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric", display: "Bang, Eric" }],
      start,
      durationMinutes: 30,
      status: "scheduled",
    }),
    id: `appt-${start.slice(11, 16)}`,
    status,
  };
}

test("office filtering keeps unassigned resources visible in every office", () => {
  const visible = visibleSchedulingResourcesForOffice(schedules(), "eyecare", config(), "main");

  assert.deepEqual(
    visible.map((resource) => scheduleReference(resource)),
    ["Schedule/sch-provider", "Schedule/sch-room"],
  );
  assert.deepEqual(
    visibleSchedulingResourcesForOffice(schedules(), "eyecare", config(), "satellite").map(
      (resource) => scheduleReference(resource),
    ),
    ["Schedule/sch-provider-2", "Schedule/sch-room"],
  );
  assert.equal(visibleSchedulingResourcesForOffice(schedules(), "eyecare", config(), "all").length, 3);
});

test("settings helpers update offices, block assigned-office removal, and copy resource hours", () => {
  const withNorth = addSchedulingOffice(config(), "North Clinic");
  assert.deepEqual(withNorth.offices.at(-1), { id: "north-clinic", name: "North Clinic" });
  const assigned = assignScheduleOffice(withNorth, "Schedule/sch-room", "north-clinic");
  assert.throws(() => removeSchedulingOffice(assigned, "north-clinic"), /still has assigned resources/);
  const copied = copyWeeklyHoursBetweenSchedules(
    {
      ...assigned,
      weeklyHoursBySchedule: {
        "Schedule/sch-provider": { mon: [{ start: "10:00", end: "14:00" }] },
      },
    },
    "Schedule/sch-provider",
    "Schedule/sch-room",
  );
  assert.deepEqual(copied.weeklyHoursBySchedule["Schedule/sch-room"], {
    mon: [{ start: "10:00", end: "14:00" }],
  });
});

test("settings helpers reserve the all-office sentinel", () => {
  const withAll = addSchedulingOffice(config(), "All");
  assert.deepEqual(withAll.offices.at(-1), { id: "all-2", name: "All" });
  assert.throws(
    () =>
      validateSchedulingPracticeSettings({
        ...config(),
        offices: [{ id: "all", name: "All" }],
      }),
    /reserved/i,
  );
});

test("settings helper rejects selected block scope with zero resources", () => {
  assert.throws(
    () => validateBlockScope({ mode: "selected", scheduleReferences: [] }),
    /selected resources/i,
  );
  assert.doesNotThrow(() => validateBlockScope({ mode: "all", scheduleReferences: [] }));
});

test("settings helper rejects overlapping or unsorted hours windows", () => {
  assert.throws(
    () =>
      validateSchedulingPracticeSettings({
        ...config(),
        defaultWeeklyHours: {
          mon: [
            { start: "09:00", end: "12:00" },
            { start: "11:30", end: "13:00" },
          ],
        },
      }),
    /overlap|sorted/i,
  );
  assert.throws(
    () =>
      validateSchedulingPracticeSettings({
        ...config(),
        defaultWeeklyHours: {
          mon: [
            { start: "13:00", end: "15:00" },
            { start: "09:00", end: "12:00" },
          ],
        },
      }),
    /overlap|sorted/i,
  );
});

test("blocked-time edit helper round-trips through the mirrored kernel validation", () => {
  const edited = replaceSchedulingBlock(config(), 0, {
    kind: "custom",
    description: "Rep lunch",
    date: "2026-07-06",
    start: "12:00",
    end: "13:00",
    scheduleReferences: ["Schedule/sch-provider"],
  });

  assert.deepEqual(edited.blocks, [
    {
      kind: "custom",
      description: "Rep lunch",
      date: "2026-07-06",
      start: "12:00",
      end: "13:00",
      scheduleReferences: ["Schedule/sch-provider"],
    },
  ]);
  assert.throws(
    () => replaceSchedulingBlock(edited, 0, { kind: "holiday" as never, date: "2026-07-06" }),
    /blocked-time kind/,
  );
});

test("blocked regions carry their source block index for click-to-edit identity", () => {
  const blockedConfig: SchedulingPracticeConfig = {
    ...config(),
    blocks: [
      { kind: "custom", description: "First", date: "2026-07-06", start: "12:00", end: "13:00" },
      {
        kind: "custom",
        description: "Second",
        date: "2026-07-06",
        start: "12:15",
        end: "12:45",
        scheduleReferences: ["Schedule/sch-provider"],
      },
    ],
  };

  const blockedRegions = availabilityShadingForColumn({
    date: "2026-07-06",
    axisStartMinutes: 12 * 60,
    axisEndMinutes: 13 * 60,
    slotMinutes: 15,
    weeklyHours: blockedConfig.defaultWeeklyHours,
    blocks: blockedConfig.blocks,
    blockIndexes: [0, 1],
  }).filter((region) => region.kind === "blocked");

  assert.deepEqual(
    blockedRegions.map((region) => [region.description, region.blockIndex]),
    [
      ["First", 0],
      ["Second", 1],
    ],
  );
});

test("findNextOpenings skips booked and blocked slots, honors duration, eligible resources, and cancelled appointments", async () => {
  const openings = await findNextOpenings({
    visitTypeCode: "routine-exam-new",
    visitTypes: [routineVisitType({ durationMinutes: 45, eligibleResourceReferences: ["Practitioner/bang-eric"] })],
    resources: schedules(),
    config: {
      ...config(),
      blocks: [{ kind: "custom", description: "Meeting", date: "2026-07-06", start: "09:30", end: "10:00" }],
    },
    from: "2026-07-06T09:00:00-05:00",
    slotMinutes: 30,
    limit: 1,
    appointmentsByDay: {
      "2026-07-06": [
        booked("2026-07-06T09:00:00-05:00"),
        booked("2026-07-06T10:00:00-05:00", "cancelled"),
      ],
    },
  });

  assert.deepEqual(openings, [
    {
      start: "2026-07-06T10:00:00-05:00",
      scheduleReference: "Schedule/sch-provider",
      actorDisplay: "Bang, Eric",
    },
  ]);
});

test("findNextOpenings crosses days, uses the async day loader, respects limit, and caps the horizon", async () => {
  const loadedDays: string[] = [];
  const baseConfig = {
    ...config(),
    defaultWeeklyHours: {
      mon: [{ start: "09:00", end: "10:00" }],
      tue: [{ start: "09:00", end: "11:00" }],
    },
  };

  const openings = await findNextOpenings({
    visitTypeCode: "routine-exam-new",
    visitTypes: [routineVisitType()],
    resources: [schedules()[0]!],
    config: {
      ...baseConfig,
      blocks: [{ kind: "office-closed", date: "2026-07-06" }],
    },
    from: "2026-07-06T09:00:00-05:00",
    slotMinutes: 30,
    limit: 2,
    loadAppointmentsForDay: async (date) => {
      loadedDays.push(date);
      return [];
    },
  });

  assert.deepEqual(openings.map((opening) => opening.start), [
    "2026-07-07T09:00:00-05:00",
    "2026-07-07T09:30:00-05:00",
  ]);
  assert.deepEqual(loadedDays, ["2026-07-07"]);

  const capped = await findNextOpenings({
    visitTypeCode: "routine-exam-new",
    visitTypes: [routineVisitType()],
    resources: [schedules()[0]!],
    config: { ...baseConfig, blocks: [{ kind: "office-closed", date: "2026-07-06" }] },
    from: "2026-07-06T09:00:00-05:00",
    slotMinutes: 30,
    limit: 1,
    horizonDays: 1,
    appointmentsByDay: { "2026-07-06": [] },
  });
  assert.deepEqual(capped, []);
});

test("findNextOpenings clamps today's search start to the next practice-local slot boundary", async () => {
  const openings = await findNextOpenings({
    visitTypeCode: "routine-exam-new",
    visitTypes: [routineVisitType()],
    resources: [schedules()[0]!],
    config: {
      ...config(),
      defaultWeeklyHours: { mon: [{ start: "09:00", end: "17:00" }] },
    },
    from: "2026-07-06T00:00:00-05:00",
    now: () => "2026-07-06T20:00:00Z",
    slotMinutes: 30,
    limit: 2,
    appointmentsByDay: { "2026-07-06": [] },
  });

  assert.deepEqual(openings.map((opening) => opening.start), [
    "2026-07-06T15:00:00-05:00",
    "2026-07-06T15:30:00-05:00",
  ]);

  const tomorrow = await findNextOpenings({
    visitTypeCode: "routine-exam-new",
    visitTypes: [routineVisitType()],
    resources: [schedules()[0]!],
    config: {
      ...config(),
      defaultWeeklyHours: { tue: [{ start: "09:00", end: "10:00" }] },
    },
    from: "2026-07-07T00:00:00-05:00",
    now: () => "2026-07-06T20:00:00Z",
    slotMinutes: 30,
    limit: 1,
    appointmentsByDay: { "2026-07-07": [] },
  });

  assert.equal(tomorrow[0]?.start, "2026-07-07T09:00:00-05:00");
});

test("findNextOpenings collapses duplicate candidates from overlapping hours windows", async () => {
  const openings = await findNextOpenings({
    visitTypeCode: "routine-exam-new",
    visitTypes: [routineVisitType()],
    resources: [schedules()[0]!],
    config: {
      ...config(),
      defaultWeeklyHours: {
        mon: [
          { start: "09:00", end: "10:00" },
          { start: "09:30", end: "10:30" },
        ],
      },
    },
    from: "2026-07-06T09:00:00-05:00",
    now: () => "2026-07-05T12:00:00Z",
    slotMinutes: 30,
    limit: 5,
    horizonDays: 1,
    appointmentsByDay: { "2026-07-06": [] },
  });

  assert.deepEqual(openings.map((opening) => opening.start), [
    "2026-07-06T09:00:00-05:00",
    "2026-07-06T09:30:00-05:00",
    "2026-07-06T10:00:00-05:00",
  ]);
});

test("findNextOpenings skips appointment fetches for closed days and empty resource sets", async () => {
  const loadedDays: string[] = [];
  const closed = await findNextOpenings({
    visitTypeCode: "routine-exam-new",
    visitTypes: [routineVisitType()],
    resources: [schedules()[0]!],
    config: {
      ...config(),
      defaultWeeklyHours: { mon: [{ start: "09:00", end: "10:00" }] },
    },
    from: "2026-07-11T00:00:00-05:00",
    now: () => "2026-07-10T12:00:00Z",
    slotMinutes: 30,
    limit: 1,
    horizonDays: 2,
    loadAppointmentsForDay: async (date) => {
      loadedDays.push(date);
      return [];
    },
  });
  assert.deepEqual(closed, []);
  assert.deepEqual(loadedDays, []);

  const emptyResources = await findNextOpenings({
    visitTypeCode: "routine-exam-new",
    visitTypes: [routineVisitType()],
    resources: [],
    config: config(),
    from: "2026-07-06T09:00:00-05:00",
    slotMinutes: 30,
    limit: 1,
    loadAppointmentsForDay: async (date) => {
      loadedDays.push(date);
      return [];
    },
  });
  assert.deepEqual(emptyResources, []);
  assert.deepEqual(loadedDays, []);
});

test("find-open search scope changes when clinic mode or visible resources change", () => {
  const resourceSet = schedules();
  assert.notEqual(
    findOpenSearchScopeKey({ clinicMode: "eyecare", resources: resourceSet }),
    findOpenSearchScopeKey({ clinicMode: "aesthetics", resources: resourceSet }),
  );
  assert.notEqual(
    findOpenSearchScopeKey({ clinicMode: "eyecare", resources: resourceSet.slice(0, 2) }),
    findOpenSearchScopeKey({ clinicMode: "eyecare", resources: resourceSet.slice(0, 1) }),
  );
});
