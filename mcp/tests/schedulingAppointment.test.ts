import assert from "node:assert/strict";
import { test } from "node:test";
import { ODOS_DISCIPLINE_SYSTEM } from "../src/scheduling/clinic-mode.js";
import {
  ODOS_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
  confirmationStatusOf,
} from "../src/fhir/appointmentConfirmation.js";
import { V2_0276_APPOINTMENT_TYPE_SYSTEM } from "../src/fhir/schedulingAppointmentStatus.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "../src/fhir/schedulingVisitType.js";
import {
  ODOS_FOLLOW_UP_EXTENSION_URL,
  ODOS_MEDICAL_COVERAGE_EXTENSION_URL,
  ODOS_VISION_COVERAGE_EXTENSION_URL,
  appointmentVisitTypeCode,
  buildSchedulingAppointment,
  isFollowUpAppointment,
  isUrgentAppointment,
  medicalCoverageOf,
  visionCoverageOf,
} from "../src/fhir/schedulingAppointment.js";

const BASE = {
  patient: { reference: "Patient/p1", display: "Doe, Jane" },
  visitTypeCode: "routine-exam-new",
  visitTypeDisplay: "Routine Exam (New)",
  discipline: "eyecare",
  resources: [{ reference: "Practitioner/bang-eric", display: "Bang, Eric" }],
  start: "2026-07-08T09:00:00-05:00",
  durationMinutes: 30,
} as const;

test("buildSchedulingAppointment builds the Eyefinity-model Appointment (brief §3.2 details modal)", () => {
  const appt = buildSchedulingAppointment({
    ...BASE,
    resources: [...BASE.resources],
    notes: "Prefers morning appointments",
  });
  assert.equal(appt.resourceType, "Appointment");
  // service type from the catalog + discipline category
  const serviceCoding = appt.serviceType?.[0]?.coding?.[0];
  assert.equal(serviceCoding?.system, ODOS_VISIT_TYPE_SYSTEM);
  assert.equal(serviceCoding?.code, "routine-exam-new");
  const categoryCoding = appt.serviceCategory?.[0]?.coding?.[0];
  assert.equal(categoryCoding?.system, ODOS_DISCIPLINE_SYSTEM);
  assert.equal(categoryCoding?.code, "eyecare");
  // participants: patient + resource, both accepted
  const actors = appt.participant.map((p) => p.actor?.reference);
  assert.deepEqual(actors, ["Patient/p1", "Practitioner/bang-eric"]);
  assert.ok(appt.participant.every((p) => p.status === "accepted"));
  // time block
  assert.equal(appt.start, "2026-07-08T09:00:00-05:00");
  assert.equal(appt.end, "2026-07-08T09:30:00-05:00");
  assert.equal(appt.minutesDuration, 30);
  // notes
  assert.equal(appt.comment, "Prefers morning appointments");
});

test("defaults: status scheduled → booked; confirmation defaults to Not Confirmed", () => {
  const appt = buildSchedulingAppointment({ ...BASE, resources: [...BASE.resources] });
  assert.equal(appt.status, "booked");
  assert.equal(confirmationStatusOf(appt), "not-confirmed");
  assert.ok(
    appt.extension?.some((e) => e.url === ODOS_APPOINTMENT_CONFIRMATION_EXTENSION_URL),
  );
});

test("the status axis lands in FHIR: walk-in → arrived + v2-0276 WALKIN appointmentType", () => {
  const appt = buildSchedulingAppointment({
    ...BASE,
    resources: [...BASE.resources],
    status: "walk-in",
  });
  assert.equal(appt.status, "arrived");
  const typeCoding = appt.appointmentType?.coding?.[0];
  assert.equal(typeCoding?.system, V2_0276_APPOINTMENT_TYPE_SYSTEM);
  assert.equal(typeCoding?.code, "WALKIN");
});

test("the confirmation axis lands as the odos extension", () => {
  const appt = buildSchedulingAppointment({
    ...BASE,
    resources: [...BASE.resources],
    confirmation: "confirmed",
  });
  assert.equal(confirmationStatusOf(appt), "confirmed");
});

test("vision + medical insurance ride as coverage extensions and read back (insurance-on-block, brief §2.4)", () => {
  const appt = buildSchedulingAppointment({
    ...BASE,
    resources: [...BASE.resources],
    visionCoverage: { reference: "Coverage/vsp-1", display: "VSP" },
    medicalCoverage: { reference: "Coverage/bcbs-1", display: "BCBS" },
  });
  const vision = appt.extension?.find((e) => e.url === ODOS_VISION_COVERAGE_EXTENSION_URL);
  assert.equal(vision?.valueReference?.reference, "Coverage/vsp-1");
  assert.equal(vision?.valueReference?.display, "VSP");
  const medical = appt.extension?.find((e) => e.url === ODOS_MEDICAL_COVERAGE_EXTENSION_URL);
  assert.equal(medical?.valueReference?.display, "BCBS");
  assert.deepEqual(visionCoverageOf(appt), { reference: "Coverage/vsp-1", display: "VSP" });
  assert.deepEqual(medicalCoverageOf(appt), { reference: "Coverage/bcbs-1", display: "BCBS" });
});

test("insurance readers are undefined when no coverage was recorded (the block shows 'none')", () => {
  const appt = buildSchedulingAppointment({ ...BASE, resources: [...BASE.resources] });
  assert.equal(visionCoverageOf(appt), undefined);
  assert.equal(medicalCoverageOf(appt), undefined);
});

test("urgent rides as iCal-highest priority 1; follow-up as the odos flag extension", () => {
  const appt = buildSchedulingAppointment({
    ...BASE,
    resources: [...BASE.resources],
    urgent: true,
    followUp: true,
  });
  assert.equal(appt.priority, 1);
  assert.equal(isUrgentAppointment(appt), true);
  const followUpExt = appt.extension?.find((e) => e.url === ODOS_FOLLOW_UP_EXTENSION_URL);
  assert.equal(followUpExt?.valueBoolean, true);
  assert.equal(isFollowUpAppointment(appt), true);

  const plain = buildSchedulingAppointment({ ...BASE, resources: [...BASE.resources] });
  assert.equal(isUrgentAppointment(plain), false);
  assert.equal(isFollowUpAppointment(plain), false);
});

test("a non-patient appointment (meetings, admin blocks) books a resource with a description and no patient", () => {
  const appt = buildSchedulingAppointment({
    visitTypeCode: "non-patient",
    visitTypeDisplay: "Non-patient Appointment",
    discipline: "eyecare",
    description: "Staff meeting",
    resources: [{ reference: "Practitioner/bang-eric" }],
    start: "2026-07-08T12:00:00-05:00",
    durationMinutes: 60,
  });
  assert.equal(appt.description, "Staff meeting");
  assert.deepEqual(
    appt.participant.map((p) => p.actor?.reference),
    ["Practitioner/bang-eric"],
  );
});

test("an appointment with neither patient nor description throws", () => {
  assert.throws(
    () =>
      buildSchedulingAppointment({
        visitTypeCode: "x",
        discipline: "eyecare",
        resources: [{ reference: "Practitioner/p" }],
        start: "2026-07-08T09:00:00-05:00",
        durationMinutes: 30,
      }),
    /patient|description/i,
  );
});

test("validation: no resources, bad duration, and start without a timezone all throw", () => {
  assert.throws(
    () => buildSchedulingAppointment({ ...BASE, resources: [] }),
    /resource/i,
  );
  assert.throws(
    () =>
      buildSchedulingAppointment({ ...BASE, resources: [...BASE.resources], durationMinutes: 0 }),
    /duration/i,
  );
  assert.throws(
    () =>
      buildSchedulingAppointment({
        ...BASE,
        resources: [...BASE.resources],
        start: "2026-07-08T09:00:00",
      }),
    /timezone|offset/i,
  );
});

test("end computation carries across the hour and preserves the practice's UTC offset", () => {
  const appt = buildSchedulingAppointment({
    ...BASE,
    resources: [...BASE.resources],
    start: "2026-07-08T16:45:00-05:00",
    durationMinutes: 30,
  });
  assert.equal(appt.end, "2026-07-08T17:15:00-05:00");
});

test("slot references and created timestamp attach when the booking flow supplies them", () => {
  const appt = buildSchedulingAppointment({
    ...BASE,
    resources: [...BASE.resources],
    slotReferences: ["Slot/s1", "Slot/s2"],
    created: "2026-07-06T14:00:00-05:00",
  });
  assert.deepEqual(
    appt.slot?.map((s) => s.reference),
    ["Slot/s1", "Slot/s2"],
  );
  assert.equal(appt.created, "2026-07-06T14:00:00-05:00");
});

test("appointmentVisitTypeCode reads the catalog code back off the appointment", () => {
  const appt = buildSchedulingAppointment({ ...BASE, resources: [...BASE.resources] });
  assert.equal(appointmentVisitTypeCode(appt), "routine-exam-new");
});
