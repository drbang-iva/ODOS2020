/**
 * ODOS scheduler demo seed.
 *
 * Populates a local Medplum stack with enough data to walk through the ODOS
 * scheduler (day / week / month) and exercise the Pass-2 fixes:
 *   - week block renders the insurance line + badges (shared ResourceDayColumn),
 *   - no week/month -> day wrong-day flash (day grid is day-scoped),
 *   - appointments booked OUTSIDE operating hours render (expanded time axis).
 *
 * Creates FHIR DATA ONLY — no login accounts. It writes the front-desk
 * AccessPolicy *resource* (ready to attach), but provisioning the front-desk
 * login user + attaching the policy is an operator step (Medplum admin app at
 * :8100, or `npm run setup-practice`). Auth flows / account creation are out of
 * scope for this script by policy.
 *
 * Run: npm run seed-scheduler   (after `npm run up`, a populated .env, and an
 * admin account). Re-running is guarded by a marker Patient; pass SEED_FORCE=1
 * to seed a second copy anyway.
 */

import type {
  AccessPolicy,
  Appointment,
  Basic,
  HealthcareService,
  Location,
  Patient,
  Practitioner,
  Schedule,
} from "@medplum/fhirtypes";
import { FhirClient } from "../src/fhir-client.js";
import { buildSchedulingResource } from "../mcp/src/fhir/schedulingResource.js";
import { defaultVisitTypeCatalog } from "../mcp/src/fhir/schedulingVisitType.js";
import { buildSchedulingAppointment } from "../mcp/src/fhir/schedulingAppointment.js";
import { buildMedplumAccessPolicy, getRoleDeclaration } from "../mcp/src/authz/roles.js";
import { buildSchedulingPracticeConfigResource } from "../ui/src/lib/scheduling-config.js";
import type { SchedulingPracticeConfig } from "../ui/src/lib/scheduling.js";

const BASE_URL = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
const EMAIL = process.env.MEDPLUM_ADMIN_EMAIL;
const PASSWORD = process.env.MEDPLUM_ADMIN_PASSWORD;
const TZ = "-05:00";
const SEED_SYSTEM = "https://osod.dev/seed/scheduler-demo";
const SEED_MARKER = "scheduler-walkthrough";

/** YYYY-MM-DD for "today" in the practice timezone (offset like "-05:00"). */
function practiceTodayYmd(offset: string): string {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  const shiftedMs = Date.now() + sign * (h * 60 + m) * 60_000;
  return new Date(shiftedMs).toISOString().slice(0, 10);
}

const DAY = practiceTodayYmd(TZ);
const at = (hhmm: string): string => `${DAY}T${hhmm}:00${TZ}`;

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    console.error("Missing MEDPLUM_ADMIN_EMAIL / MEDPLUM_ADMIN_PASSWORD. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const client = new FhirClient({ baseUrl: BASE_URL });
  await client.login(EMAIL, PASSWORD);
  console.log("✓ Logged in as", EMAIL);

  // Idempotency guard: bail if the marker patient already exists.
  const existing = await client.search<Patient>("Patient", { identifier: `${SEED_SYSTEM}|${SEED_MARKER}` });
  if ((existing.entry?.length ?? 0) > 0 && process.env.SEED_FORCE !== "1") {
    console.log("Already seeded (marker Patient found). Re-run with SEED_FORCE=1 to seed another copy.");
    return;
  }

  // 1. Providers + a room, each backed by a Schedule (actor = Practitioner/Location).
  const eric = await client.create<Practitioner>({
    resourceType: "Practitioner",
    active: true,
    name: [{ family: "Bang", given: ["Eric"], text: "Bang, Eric" }],
  });
  const sarah = await client.create<Practitioner>({
    resourceType: "Practitioner",
    active: true,
    name: [{ family: "Smith", given: ["Sarah"], text: "Smith, Sarah" }],
  });
  const room = await client.create<Location>({ resourceType: "Location", status: "active", name: "Treatment Room 1" });

  const ericSchedule = await client.create<Schedule>(
    buildSchedulingResource({
      kind: "provider",
      actorReference: `Practitioner/${eric.id}`,
      actorDisplay: "Bang, Eric",
      disciplines: ["eyecare"],
    }),
  );
  const sarahSchedule = await client.create<Schedule>(
    buildSchedulingResource({
      kind: "provider",
      actorReference: `Practitioner/${sarah.id}`,
      actorDisplay: "Smith, Sarah",
      disciplines: ["aesthetics"],
    }),
  );
  const roomSchedule = await client.create<Schedule>(
    buildSchedulingResource({
      kind: "room",
      actorReference: `Location/${room.id}`,
      actorDisplay: "Treatment Room 1",
      disciplines: ["eyecare", "aesthetics"],
    }),
  );
  console.log(`✓ Resources: ${ericSchedule.id} (Eric), ${sarahSchedule.id} (Sarah), ${roomSchedule.id} (Room 1)`);

  // 2. Visit-type catalog (shipped defaults, both disciplines).
  const catalog = defaultVisitTypeCatalog("both");
  for (const visitType of catalog) {
    await client.create<HealthcareService>(visitType);
  }
  console.log(`✓ Visit-type catalog: ${catalog.length} HealthcareService entries`);

  // 3. Practice config — Mon-Fri 9-5, Eric opens at 10 on Mon, lunch block.
  //    Keyed by SCHEDULE references (scheduleReference), not actor references.
  const config: SchedulingPracticeConfig = {
    timezoneOffset: TZ,
    defaultWeeklyHours: {
      mon: [{ start: "09:00", end: "17:00" }],
      tue: [{ start: "09:00", end: "17:00" }],
      wed: [{ start: "09:00", end: "17:00" }],
      thu: [{ start: "09:00", end: "17:00" }],
      fri: [{ start: "09:00", end: "17:00" }],
    },
    weeklyHoursBySchedule: {
      [`Schedule/${ericSchedule.id}`]: { mon: [{ start: "10:00", end: "17:00" }] },
    },
    blocks: [
      {
        kind: "custom",
        description: "Lunch",
        weekdays: ["mon", "tue", "wed", "thu", "fri"],
        start: "12:00",
        end: "13:00",
      },
    ],
    offices: [{ id: "main", name: "Main Office" }],
    officeBySchedule: {
      [`Schedule/${ericSchedule.id}`]: "main",
      [`Schedule/${sarahSchedule.id}`]: "main",
      [`Schedule/${roomSchedule.id}`]: "main",
    },
  };
  await client.create<Basic>(buildSchedulingPracticeConfigResource(config));
  console.log("✓ Practice config (Mon-Fri 9-5, lunch block, Main Office)");

  // 4. A synthetic patient (marker identifier drives the idempotency guard).
  // Test-data guardrail: TEST- name prefix + 1900 DOB so demo patients can never
  // be confused with real PHI.
  const patient = await client.create<Patient>({
    resourceType: "Patient",
    active: true,
    name: [{ family: "TEST-Doe", given: ["Jane"], text: "TEST-Doe, Jane" }],
    identifier: [
      { system: SEED_SYSTEM, value: SEED_MARKER },
      { system: "https://practice.local/mrn", value: "MRN-TEST-001" },
    ],
    birthDate: "1900-01-01",
    gender: "female",
  });
  const patientRef = { reference: `Patient/${patient.id}`, display: "TEST-Doe, Jane" };
  const ericRef = { reference: `Practitioner/${eric.id}`, display: "Bang, Eric" };
  const sarahRef = { reference: `Practitioner/${sarah.id}`, display: "Smith, Sarah" };

  // 5. Appointments on TODAY — actor references (not Schedule refs) so geometry
  //    matches them onto the resource columns.
  const appts: Appointment[] = [
    // in-hours, vision insurance + confirmed -> insurance line + confirmation badge
    buildSchedulingAppointment({
      patient: patientRef,
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [ericRef],
      start: at("09:15"),
      durationMinutes: 30,
      confirmation: "confirmed",
      visionCoverage: { display: "VSP" },
    }),
    // OUT OF HOURS: 07:30, before Eric's 10:00 Mon open (9:00 other days) -> the fix
    buildSchedulingAppointment({
      patient: patientRef,
      visitTypeCode: "routine-exam-established",
      discipline: "eyecare",
      resources: [ericRef],
      start: at("07:30"),
      durationMinutes: 30,
      confirmation: "confirmed",
      urgent: true,
    }),
    // special testing, medical insurance, not confirmed -> insurance + badges
    buildSchedulingAppointment({
      patient: patientRef,
      visitTypeCode: "special-testing",
      discipline: "eyecare",
      resources: [ericRef],
      start: at("11:00"),
      durationMinutes: 60,
      confirmation: "not-confirmed",
      medicalCoverage: { display: "BCBS" },
      followUp: true,
    }),
    // aesthetics (combined-mode color separation)
    buildSchedulingAppointment({
      patient: patientRef,
      visitTypeCode: "aesthetics-consult",
      discipline: "aesthetics",
      resources: [sarahRef],
      start: at("14:00"),
      durationMinutes: 45,
      confirmation: "left-message",
    }),
    // non-patient block on a resource column
    buildSchedulingAppointment({
      description: "Team Huddle",
      visitTypeCode: "office-visit",
      discipline: "eyecare",
      resources: [ericRef],
      start: at("08:00"),
      durationMinutes: 30,
    }),
  ];
  for (const appt of appts) {
    await client.create<Appointment>(appt);
  }
  console.log(`✓ ${appts.length} appointments on ${DAY} (incl. a 07:30 out-of-hours booking)`);

  // 6. Front-desk AccessPolicy RESOURCE (ready to attach — no login user created).
  const frontDeskPolicy = await client.create<AccessPolicy>({
    ...buildMedplumAccessPolicy(getRoleDeclaration("front-desk")),
    name: "ODOS Front Desk (scheduler walkthrough)",
  });
  console.log(`✓ Front-desk AccessPolicy: AccessPolicy/${frontDeskPolicy.id}`);

  console.log("\n— ODOS scheduler demo data ready —");
  console.log(`Seeded day: ${DAY}  (open the scheduler; day view defaults to today)`);
  console.log(`Admin app:  ${BASE_URL.replace(":8103", ":8100")}`);
  console.log("\nProvision the front-desk LOGIN (operator step — not done by this script):");
  console.log(`  1. Medplum admin app -> Project -> Users -> Invite user (a front desk email).`);
  console.log(`  2. Attach AccessPolicy/${frontDeskPolicy.id} to that membership.`);
  console.log(`  3. Log into the ODOS UI as that user for the #27 RBAC walkthrough.`);
}

main().catch((e: unknown) => {
  console.error("Seed error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
