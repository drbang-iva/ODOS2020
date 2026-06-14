/**
 * OSOD v0.0.1 — First FHIR flow.
 *
 * Proves the Medplum foundation works by creating:
 *   Patient → Encounter → ChargeItem (deferred procedure concept)
 *
 * Screenshot the resulting resources in Medplum admin UI for the
 * licensing check: procedure concepts stay decoupled from proprietary CPT data.
 *
 * Run: npm run poc  (after `npm run up` and admin account created)
 */

import type {
  Patient,
  Encounter,
  ChargeItem,
  Reference,
} from "@medplum/fhirtypes";
import { FhirClient } from "./fhir-client.js";

const BASE_URL = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
const EMAIL = process.env.MEDPLUM_ADMIN_EMAIL;
const PASSWORD = process.env.MEDPLUM_ADMIN_PASSWORD;
const DEFERRED_PROCEDURE_CONCEPT_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/deferred-procedure-concepts";
const CPT_CODE_SYSTEM = "urn:ama:cpt";

interface DeferredCptBoundProcedure {
  conceptKey: string;
  cptBinding: {
    status: "deferred-to-licensed-adapter";
    system: typeof CPT_CODE_SYSTEM;
  };
}

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    console.error(
      "Missing MEDPLUM_ADMIN_EMAIL / MEDPLUM_ADMIN_PASSWORD. Copy .env.example to .env and fill in.",
    );
    process.exit(1);
  }

  const client = new FhirClient({ baseUrl: BASE_URL });
  await client.login(EMAIL, PASSWORD);
  console.log("✓ Logged in as", EMAIL);

  // 1. Patient — fake test patient, no PHI
  const patient = await client.create<Patient>({
    resourceType: "Patient",
    name: [{ family: "Testington", given: ["Demo"] }],
    gender: "other",
    birthDate: "1980-01-01",
  });
  console.log("✓ Created Patient:", patient.id);

  const patientRef: Reference<Patient> = {
    reference: `Patient/${patient.id}`,
    display: "Demo Testington",
  };

  // 2. Encounter — ambulatory office visit (FHIR-correct: type is visit type,
  //    not a licensed procedure code. Procedure concepts go on ChargeItem/Procedure.)
  const encounter = await client.create<Encounter>({
    resourceType: "Encounter",
    status: "finished",
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "AMB",
      display: "ambulatory",
    },
    type: [
      {
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "185349003",
            display: "Encounter for check up (procedure)",
          },
        ],
        text: "Office visit",
      },
    ],
    subject: patientRef,
    period: {
      start: new Date().toISOString(),
      end: new Date().toISOString(),
    },
  });
  console.log("✓ Created Encounter:", encounter.id);

  // 3. ChargeItems — deferred procedure concepts performed during this encounter.
  //    CPT values load later through the practice's own licensed adapter.
  const procedures: DeferredCptBoundProcedure[] = [
    deferredCptBoundProcedure("comprehensive-established-eye-exam"),
    deferredCptBoundProcedure("refraction-determination"),
    deferredCptBoundProcedure("fundus-photography"),
  ];

  const charges: ChargeItem[] = [];
  for (const p of procedures) {
    const charge = await client.create<ChargeItem>({
      resourceType: "ChargeItem",
      status: "billable",
      code: {
        coding: [
          {
            system: DEFERRED_PROCEDURE_CONCEPT_SYSTEM,
            code: p.conceptKey,
          },
        ],
        text: p.conceptKey,
      },
      subject: patientRef,
      context: { reference: `Encounter/${encounter.id}` },
      occurrenceDateTime: new Date().toISOString(),
      quantity: { value: 1 },
    });
    charges.push(charge);
    console.log(`✓ Created ChargeItem (${p.conceptKey}):`, charge.id);
  }

  console.log("\n— Demo ready —");
  console.log(`Admin UI: ${BASE_URL.replace(":8103", ":8100")}`);
  console.log(`Patient:    Patient/${patient.id}`);
  console.log(`Encounter:  Encounter/${encounter.id}  (Office visit — no procedure code)`);
  for (const [i, c] of charges.entries()) {
    console.log(`ChargeItem: ChargeItem/${c.id}  (${procedures[i].conceptKey})`);
  }
  console.log(
    "\nChargeItems use OSOD-local concept keys with CPT binding deferred to\n" +
      "the practice's licensed adapter. No CPT value or descriptor ships in\n" +
      "this public demo.",
  );
}

function deferredCptBoundProcedure(conceptKey: string): DeferredCptBoundProcedure {
  return {
    conceptKey,
    cptBinding: {
      status: "deferred-to-licensed-adapter",
      system: CPT_CODE_SYSTEM,
    },
  };
}

main().catch((e: unknown) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
