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

  // 3. ChargeItem — CPT 92015 (refraction) bound to encounter + patient.
  //    This is where CPT procedure codes actually belong in FHIR.
  const charge = await client.create<ChargeItem>({
    resourceType: "ChargeItem",
    status: "billable",
    code: {
      coding: [
        {
          system: "http://www.ama-assn.org/go/cpt",
          code: "92015",
          display: "Determination of refractive state",
        },
      ],
      text: "CPT 92015 - Determination of refractive state",
    },
    subject: patientRef,
    context: { reference: `Encounter/${encounter.id}` },
    occurrenceDateTime: new Date().toISOString(),
    quantity: { value: 1 },
  });
  console.log("✓ Created ChargeItem (CPT 92015):", charge.id);

  console.log("\n— Demo ready —");
  console.log(`Admin UI: ${BASE_URL.replace(":8103", ":8100")}`);
  console.log(`Patient:     Patient/${patient.id}`);
  console.log(`Encounter:   Encounter/${encounter.id}`);
  console.log(`ChargeItem:  ChargeItem/${charge.id}`);
  console.log(
    "\nThe CPT code 92015 exists ONLY inside this ChargeItem, which references\n" +
      "the Encounter, which references the Patient. Structurally inseparable\n" +
      "from clinical context — satisfies AMA distribution criterion (a).",
  );
}

main().catch((e: unknown) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
