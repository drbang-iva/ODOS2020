import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AllergyIntolerance,
  CarePlan,
  Condition,
  Encounter,
  MedicationRequest,
  Observation,
  Patient,
} from "@medplum/fhirtypes";
import {
  CORRESPONDENCE_TOKEN_NAMES,
  resolveCorrespondenceTemplate,
} from "../src/correspondence/tokens/registry.js";
import type { CorrespondenceTokenContext } from "../src/correspondence/tokens/types.js";

test("fixed correspondence token registry resolves identity, clinical blocks, and actual ODOS eye tables", () => {
  const resolved = resolveCorrespondenceTemplate(
    CORRESPONDENCE_TOKEN_NAMES.map((name) => `<section data-token="${name}">{{${name}}}</section>`).join(""),
    context(),
  );

  for (const token of CORRESPONDENCE_TOKEN_NAMES) {
    assert.doesNotMatch(resolved, new RegExp(`\\{\\{${token.replace(".", "\\.")}\\}\\}`));
  }
  assert.match(resolved, /Jane &amp; Doe/);
  assert.match(resolved, /02\/03\/1980/);
  assert.match(resolved, /Retina &lt;Group&gt;/);
  assert.match(resolved, /Dr\. Rosa Rivera/);
  assert.match(resolved, /OD, FAAO/);
  assert.match(resolved, /07\/30\/2026/);
  assert.match(resolved, /864-555-0100/);
  assert.match(resolved, /Macular finding/);
  assert.match(resolved, /Retina consultation/);
  assert.match(resolved, /Latanoprost/);
  assert.match(resolved, /Penicillin/);
  assert.match(resolved, /Prior comprehensive exam/);
  assert.match(resolved, /data-correspondence-table="va"/);
  assert.match(resolved, /20\/20/);
  assert.match(resolved, /data-correspondence-table="iop"/);
  assert.match(resolved, />18 mm\[Hg\]</);
  assert.match(resolved, /data-correspondence-table="refraction"/);
  assert.match(resolved, /-1\.25/);
  assert.match(resolved, /Visual-field summary unavailable: ODOS has no visual-field data model yet\./);
});

test("token registry rejects unknown template reach instead of evaluating arbitrary paths", () => {
  assert.throws(
    () => resolveCorrespondenceTemplate("<p>{{patient.secret}}</p>", context()),
    /Unknown correspondence token: patient\.secret/,
  );
});

function context(): CorrespondenceTokenContext {
  const patient: Patient = {
    resourceType: "Patient",
    id: "p1",
    name: [{ text: "Jane & Doe" }],
    birthDate: "1980-02-03",
    telecom: [{ system: "phone", value: "864-555-0199" }],
  };
  const encounter: Encounter = {
    resourceType: "Encounter",
    id: "e1",
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
    period: { start: "2026-07-30T13:00:00Z" },
  };
  const findings: Observation[] = [
    observation("finding", "MACULAR_FINDING", "Macular finding", {
      valueString: "central distortion",
    }),
    observation("va-od", "VISUAL_ACUITY", "Visual acuity", {
      bodySite: odosConcept("OD", "Right eye"),
      component: [
        component("VA_SNELLEN_RAW", { valueString: "20/20" }),
        component("VA_CORRECTION", { valueCodeableConcept: odosConcept("CC", "With correction") }),
      ],
    }),
    observation("iop-os", "INTRAOCULAR_PRESSURE", "Intraocular pressure", {
      bodySite: odosConcept("OS", "Left eye"),
      valueQuantity: { value: 18, unit: "mm[Hg]" },
    }),
    observation("rx-od", "REFRACTION", "Refraction", {
      bodySite: odosConcept("OD", "Right eye"),
      component: [
        component("REFRACTION_TYPE", { valueCodeableConcept: odosConcept("manifest", "Manifest") }),
        component("SPHERE", { valueQuantity: { value: -1.25, unit: "D" } }),
        component("CYLINDER", { valueQuantity: { value: -0.5, unit: "D" } }),
        component("AXIS", { valueQuantity: { value: 90, unit: "degrees" } }),
      ],
    }),
  ];
  const plans: CarePlan[] = [{
    resourceType: "CarePlan",
    status: "active",
    intent: "plan",
    subject: { reference: "Patient/p1" },
    title: "Retina consultation",
  }];
  const conditions: Condition[] = [{
    resourceType: "Condition",
    subject: { reference: "Patient/p1" },
    code: { text: "Myopia" },
  }];
  const medicationRequests: MedicationRequest[] = [{
    resourceType: "MedicationRequest",
    status: "active",
    intent: "order",
    subject: { reference: "Patient/p1" },
    medicationCodeableConcept: { text: "Latanoprost" },
  }];
  const allergies: AllergyIntolerance[] = [{
    resourceType: "AllergyIntolerance",
    patient: { reference: "Patient/p1" },
    code: { text: "Penicillin" },
  }];
  return {
    patient,
    encounter,
    recipientName: "Retina <Group>",
    senderName: "Dr. Rosa Rivera",
    senderCredentials: "OD, FAAO",
    practicePhone: "864-555-0100",
    findings,
    plans,
    history: [{
      resourceType: "Encounter",
      id: "old",
      status: "finished",
      class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
      subject: { reference: "Patient/p1" },
      type: [{ text: "Prior comprehensive exam" }],
      period: { start: "2025-07-01" },
    }],
    clinicalSummary: {
      conditions,
      medicationRequests,
      medicationStatements: [],
      allergies,
    },
  };
}

function observation(
  id: string,
  code: string,
  display: string,
  fields: Partial<Observation>,
): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "final",
    code: odosConcept(code, display),
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    ...fields,
  };
}

function component(code: string, value: Partial<NonNullable<Observation["component"]>[number]>) {
  return { code: odosConcept(code, code), ...value };
}

function odosConcept(code: string, display: string) {
  return {
    coding: [{
      system: "https://odos2020.com/fhir/CodeSystem/ophthalmology",
      code,
      display,
    }],
    text: display,
  };
}
