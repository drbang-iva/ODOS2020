/**
 * OSOD v0.0.1 — First FHIR flow.
 *
 * Proves the Medplum foundation works by creating:
 *   Patient → Encounter → ChargeItem (CPT 92015)
 *
 * Screenshot the resulting resources in Medplum admin UI for the
 * AMA / Chacon call: "CPT codes only appear inside clinical context."
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

  // 2. Encounter — ambulatory office visit (FHIR-correct: type is VISIT-TYPE,
  //    NOT a CPT procedure code. Procedure codes go on ChargeItem/Procedure.)
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

  // 3. ChargeItems — three CPT procedures performed during this encounter.
  //    Each is independently billable, each is bound to the same encounter.
  //    CPT procedure codes live ONLY here, never on Patient or Encounter.
  const procedures = [
    { code: "92014", display: "Ophthalmological services: comprehensive, established patient" },
    { code: "92015", display: "Determination of refractive state" },
    { code: "92250", display: "Fundus photography with interpretation and report" },
  ];

  const charges: ChargeItem[] = [];
  for (const p of procedures) {
    const charge = await client.create<ChargeItem>({
      resourceType: "ChargeItem",
      status: "billable",
      code: {
        coding: [
          {
            system: "http://www.ama-assn.org/go/cpt",
            code: p.code,
            display: p.display,
          },
        ],
        text: `CPT ${p.code} - ${p.display}`,
      },
      subject: patientRef,
      context: { reference: `Encounter/${encounter.id}` },
      occurrenceDateTime: new Date().toISOString(),
      quantity: { value: 1 },
    });
    charges.push(charge);
    console.log(`✓ Created ChargeItem (CPT ${p.code}):`, charge.id);
  }

  console.log("\n— Demo ready —");
  console.log(`Admin UI: ${BASE_URL.replace(":8103", ":8100")}`);
  console.log(`Patient:    Patient/${patient.id}`);
  console.log(`Encounter:  Encounter/${encounter.id}  (Office visit — no CPT)`);
  for (const [i, c] of charges.entries()) {
    console.log(`ChargeItem: ChargeItem/${c.id}  (CPT ${procedures[i].code})`);
  }
  console.log(
    "\nCPT codes 92014, 92015, 92250 exist ONLY inside ChargeItems, each\n" +
      "bound to the Encounter, which is bound to the Patient. No CPT appears\n" +
      "on Patient, Encounter, or anywhere else. Structurally inseparable\n" +
      "from clinical context — satisfies AMA distribution criterion (a).",
  );
}

main().catch((e: unknown) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
