import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Appointment,
  Bundle,
  HealthcareService,
  Resource,
  Schedule,
} from "@medplum/fhirtypes";
import { buildSchedulingResource } from "../src/fhir/schedulingResource.js";
import { defaultVisitTypeCatalog, visitTypeCode } from "../src/fhir/schedulingVisitType.js";
import { buildSchedulingAppointment } from "../src/fhir/schedulingAppointment.js";
import {
  type SchedulingFhirClient,
  createSchedulingService,
} from "../src/scheduling/scheduling-service.js";

/** In-memory fake of the FHIR client seam (payments-slice test idiom). */
function fakeFhir(seed: {
  visitTypes?: HealthcareService[];
  schedules?: Schedule[];
  appointments?: Appointment[];
}): SchedulingFhirClient & { created: Resource[] } {
  const actorResources = (seed.schedules ?? []).flatMap((schedule): Resource[] => {
    const [resourceType, id] = schedule.actor?.[0]?.reference?.split("/") ?? [];
    return resourceType && id ? [{ resourceType, id } as Resource] : [];
  });
  const byType: Record<string, Resource[]> = {
    HealthcareService: [...(seed.visitTypes ?? [])],
    Schedule: [...(seed.schedules ?? [])],
    Appointment: [...(seed.appointments ?? [])],
  };
  for (const actor of actorResources) {
    byType[actor.resourceType] = [...(byType[actor.resourceType] ?? []), actor];
  }
  const created: Resource[] = [];
  return {
    created,
    async read(rt: string, id: string) {
      const match = (byType[rt] ?? []).find((r) => r.id === id);
      if (!match) {
        throw new Error(`${rt}/${id} not found`);
      }
      return match as never;
    },
    async search(rt: string) {
      const entry = (byType[rt] ?? []).map((resource) => ({ resource }));
      return { resourceType: "Bundle", type: "searchset", entry } as Bundle as never;
    },
    async create(resource: Resource) {
      const withId = { ...resource, id: `${resource.resourceType}-${created.length + 1}` };
      created.push(withId);
      byType[resource.resourceType] = [...(byType[resource.resourceType] ?? []), withId];
      return withId as never;
    },
  } as SchedulingFhirClient & { created: Resource[] };
}

function seededCatalog(): HealthcareService[] {
  return defaultVisitTypeCatalog("both").map((hs, i) => ({ ...hs, id: `vt-${i + 1}` }));
}

function seededSchedules(): Schedule[] {
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
        actorDisplay: "Aesthetics/Treatments",
        disciplines: ["aesthetics"],
      }),
      id: "sch-room",
    },
  ];
}

const NOW = () => "2026-07-06T14:00:00-05:00";

test("listVisitTypes filters the catalog by clinic mode — the modularity axis at the service seam", async () => {
  const fhir = fakeFhir({ visitTypes: seededCatalog() });
  const eyecare = createSchedulingService({ fhir, clinicMode: "eyecare", now: NOW });
  const combined = createSchedulingService({ fhir, clinicMode: "both", now: NOW });

  const eyecareTypes = await eyecare.listVisitTypes();
  const combinedTypes = await combined.listVisitTypes();
  assert.ok(eyecareTypes.length > 0);
  assert.ok(eyecareTypes.every((hs) => !visitTypeCode(hs)?.startsWith("aesthetics")));
  assert.equal(combinedTypes.length, seededCatalog().length);
});

test("listResources filters resource columns by clinic mode", async () => {
  const fhir = fakeFhir({ schedules: seededSchedules() });
  const aestheticsOnly = createSchedulingService({ fhir, clinicMode: "aesthetics", now: NOW });
  const resources = await aestheticsOnly.listResources();
  assert.deepEqual(
    resources.map((s) => s.id),
    ["sch-room"],
  );
});

test("bookAppointment books off the catalog: duration/display/discipline derived, resource actor resolved from the Schedule", async () => {
  const fhir = fakeFhir({ visitTypes: seededCatalog(), schedules: seededSchedules() });
  const service = createSchedulingService({ fhir, clinicMode: "both", now: NOW });

  const appointment = await service.bookAppointment({
    patient: { reference: "Patient/p1", display: "Doe, Jane" },
    visitTypeCode: "routine-exam-new",
    resourceScheduleReferences: ["Schedule/sch-provider"],
    start: "2026-07-08T09:00:00-05:00",
  });

  assert.equal(appointment.resourceType, "Appointment");
  assert.equal(appointment.status, "booked");
  assert.equal(appointment.minutesDuration, 30); // catalog default
  assert.equal(appointment.end, "2026-07-08T09:30:00-05:00");
  assert.equal(appointment.created, NOW());
  const actors = appointment.participant.map((p) => p.actor?.reference);
  assert.deepEqual(actors, ["Patient/p1", "Practitioner/bang-eric"]);
  assert.equal(appointment.participant[1]?.actor?.display, "Bang, Eric");
  assert.equal(fhir.created.length, 1);
});

test("a caller duration override beats the catalog default", async () => {
  const fhir = fakeFhir({ visitTypes: seededCatalog(), schedules: seededSchedules() });
  const service = createSchedulingService({ fhir, clinicMode: "both", now: NOW });
  const appointment = await service.bookAppointment({
    patient: { reference: "Patient/p1" },
    visitTypeCode: "routine-exam-new",
    resourceScheduleReferences: ["Schedule/sch-provider"],
    start: "2026-07-08T09:00:00-05:00",
    durationMinutes: 45,
  });
  assert.equal(appointment.minutesDuration, 45);
});

test("MODULARITY GUARD: an eyecare-only practice cannot book an aesthetics visit type", async () => {
  const fhir = fakeFhir({ visitTypes: seededCatalog(), schedules: seededSchedules() });
  const service = createSchedulingService({ fhir, clinicMode: "eyecare", now: NOW });
  await assert.rejects(
    service.bookAppointment({
      patient: { reference: "Patient/p1" },
      visitTypeCode: "aesthetics-consult",
      resourceScheduleReferences: ["Schedule/sch-provider"],
      start: "2026-07-08T09:00:00-05:00",
    }),
    /clinic mode|not available/i,
  );
});

test("an unknown visit type is rejected", async () => {
  const fhir = fakeFhir({ visitTypes: seededCatalog(), schedules: seededSchedules() });
  const service = createSchedulingService({ fhir, clinicMode: "both", now: NOW });
  await assert.rejects(
    service.bookAppointment({
      patient: { reference: "Patient/p1" },
      visitTypeCode: "unicorn-exam",
      resourceScheduleReferences: ["Schedule/sch-provider"],
      start: "2026-07-08T09:00:00-05:00",
    }),
    /visit type/i,
  );
});

test("eligible-resource restriction is enforced when the catalog entry declares one", async () => {
  const catalog = seededCatalog();
  const special = catalog.find((hs) => visitTypeCode(hs) === "special-testing")!;
  special.extension = [
    ...(special.extension ?? []),
    {
      url: "https://odos2020.com/fhir/StructureDefinition/odos-eligible-resource",
      valueReference: { reference: "Device/oct-1" },
    },
  ];
  const fhir = fakeFhir({ visitTypes: catalog, schedules: seededSchedules() });
  const service = createSchedulingService({ fhir, clinicMode: "eyecare", now: NOW });
  await assert.rejects(
    service.bookAppointment({
      patient: { reference: "Patient/p1" },
      visitTypeCode: "special-testing",
      resourceScheduleReferences: ["Schedule/sch-provider"],
      start: "2026-07-08T09:00:00-05:00",
    }),
    /eligible/i,
  );
});

test("double-booking a resource throws — unless the front desk explicitly overbooks", async () => {
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
  const fhir = fakeFhir({
    visitTypes: seededCatalog(),
    schedules: seededSchedules(),
    appointments: [existing],
  });
  const service = createSchedulingService({ fhir, clinicMode: "both", now: NOW });

  await assert.rejects(
    service.bookAppointment({
      patient: { reference: "Patient/p1" },
      visitTypeCode: "routine-exam-new",
      resourceScheduleReferences: ["Schedule/sch-provider"],
      start: "2026-07-08T09:15:00-05:00",
    }),
    /already booked|conflict/i,
  );

  const overbooked = await service.bookAppointment({
    patient: { reference: "Patient/p1" },
    visitTypeCode: "routine-exam-new",
    resourceScheduleReferences: ["Schedule/sch-provider"],
    start: "2026-07-08T09:15:00-05:00",
    allowDoubleBook: true,
  });
  assert.equal(overbooked.resourceType, "Appointment");
});

test("a cancelled appointment never blocks the slot", async () => {
  const cancelled: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p0" },
      visitTypeCode: "routine-exam-established",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }],
      start: "2026-07-08T09:00:00-05:00",
      durationMinutes: 30,
      status: "cancelled",
    }),
    id: "appt-cancelled",
  };
  const fhir = fakeFhir({
    visitTypes: seededCatalog(),
    schedules: seededSchedules(),
    appointments: [cancelled],
  });
  const service = createSchedulingService({ fhir, clinicMode: "both", now: NOW });
  const appointment = await service.bookAppointment({
    patient: { reference: "Patient/p1" },
    visitTypeCode: "routine-exam-new",
    resourceScheduleReferences: ["Schedule/sch-provider"],
    start: "2026-07-08T09:00:00-05:00",
  });
  assert.equal(appointment.resourceType, "Appointment");
});

test("getAvailability overlays booked appointments as busy on the generated slot grid", async () => {
  const existing: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p0" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }],
      start: "2026-07-06T09:00:00-05:00",
      durationMinutes: 30,
    }),
    id: "appt-1",
  };
  const fhir = fakeFhir({ schedules: seededSchedules(), appointments: [existing] });
  const service = createSchedulingService({ fhir, clinicMode: "both", now: NOW });

  const slots = await service.getAvailability({
    scheduleReference: "Schedule/sch-provider",
    weeklyHours: { mon: [{ start: "09:00", end: "11:00" }] },
    slotMinutes: 30,
    from: "2026-07-06",
    to: "2026-07-06",
    timezoneOffset: "-05:00",
  });

  const byStart = new Map(slots.map((s) => [s.start.slice(11, 16), s.status]));
  assert.equal(byStart.get("09:00"), "busy");
  assert.equal(byStart.get("09:30"), "free");
  assert.equal(byStart.get("10:00"), "free");
});

test("getAvailability keeps blocked time busy-unavailable, distinct from booked busy", async () => {
  const fhir = fakeFhir({ schedules: seededSchedules() });
  const service = createSchedulingService({ fhir, clinicMode: "both", now: NOW });
  const slots = await service.getAvailability({
    scheduleReference: "Schedule/sch-provider",
    weeklyHours: { mon: [{ start: "09:00", end: "11:00" }] },
    slotMinutes: 30,
    from: "2026-07-06",
    to: "2026-07-06",
    timezoneOffset: "-05:00",
    blocks: [{ kind: "staff-off", date: "2026-07-06", start: "10:00", end: "11:00" }],
  });
  const byStart = new Map(slots.map((s) => [s.start.slice(11, 16), s.status]));
  assert.equal(byStart.get("09:00"), "free");
  assert.equal(byStart.get("10:00"), "busy-unavailable");
  assert.equal(byStart.get("10:30"), "busy-unavailable");
});
