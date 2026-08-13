import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItem, Condition, Coverage, Encounter, Resource } from "@medplum/fhirtypes";
import {
  handleDiagnosisOrderRequest,
  type DiagnosisOrderFhirClient,
} from "../src/clinical-graph/diagnosis-order-endpoint.js";
import {
  FHIR_CONDITION_CATEGORY_CODE_SYSTEM,
  FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM,
} from "../src/fhir/condition.js";
import { buildClaimDraft } from "../src/claims/claim-draft.js";

const ENCOUNTER_ID = "enc-order";
const CONFIRMED_A = confirmedCondition("confirmed-a", "DX-A");
const CONFIRMED_B = confirmedCondition("confirmed-b", "DX-B");
const PROVISIONAL_C = provisionalCondition("provisional-c", "DX-C");

test("reorder promotes a confirmed secondary with one conditional Encounter update and loses no diagnosis", async () => {
  const fixture = orderFixture();

  const result = await reorder(fixture, [
    "Condition/confirmed-b",
    "Condition/confirmed-a",
    "Condition/provisional-c",
  ]);

  assert.equal(result.status, 200);
  assert.equal(fixture.updateCalls.length, 1);
  assert.equal(fixture.updateCalls[0]?.resourceType, "Encounter");
  assert.equal(fixture.updateCalls[0]?.id, ENCOUNTER_ID);
  assert.deepEqual(fixture.updateCalls[0]?.headers, {
    "If-Match": 'W/"7"',
    "X-ODOS-Source": "diagnosis-order",
  });
  assert.deepEqual(fixture.updateCalls[0]?.resource.diagnosis, [
    { condition: { reference: "Condition/confirmed-a" }, rank: 2 },
    { condition: { reference: "Condition/confirmed-b" }, rank: 1 },
    { condition: { reference: "Condition/provisional-c" }, rank: 3 },
  ]);
  assert.deepEqual(fixture.updateCalls[0]?.resource.extension, [{
    url: "https://odos2020.com/fhir/StructureDefinition/intended-coverage",
    valueReference: { reference: "Coverage/coverage-1" },
  }]);
  assert.deepEqual(
    new Set(fixture.updateCalls[0]?.resource.diagnosis?.map((entry) => entry.condition.reference)),
    new Set([
      "Condition/confirmed-a",
      "Condition/confirmed-b",
      "Condition/provisional-c",
    ]),
  );
});

test("every accepted ordering receives unique positive contiguous ranks with exactly one principal", async () => {
  for (const order of [
    ["Condition/confirmed-a", "Condition/confirmed-b", "Condition/provisional-c"],
    ["Condition/confirmed-a", "Condition/provisional-c", "Condition/confirmed-b"],
    ["Condition/confirmed-b", "Condition/confirmed-a", "Condition/provisional-c"],
    ["Condition/confirmed-b", "Condition/provisional-c", "Condition/confirmed-a"],
  ]) {
    const fixture = orderFixture();
    const result = await reorder(fixture, order);
    assert.equal(result.status, 200, order.join(","));
    const ranks = fixture.updateCalls[0]?.resource.diagnosis?.map((entry) => entry.rank) ?? [];
    assert.equal(ranks.every((rank) => Number.isInteger(rank) && rank! > 0), true);
    assert.equal(new Set(ranks).size, 3);
    assert.equal(ranks.filter((rank) => rank === 1).length, 1);
    assert.deepEqual([...ranks].sort((left, right) => left! - right!), [1, 2, 3]);
  }
});

test("endpoint rejects a permutation that places a provisional diagnosis first", async () => {
  const fixture = orderFixture();

  const result = await reorder(fixture, [
    "Condition/provisional-c",
    "Condition/confirmed-a",
    "Condition/confirmed-b",
  ]);

  assert.equal(result.status, 422);
  assert.match(errorMessage(result.body), /provisional diagnosis cannot be principal/i);
  assert.equal(fixture.updateCalls.length, 0);
});

test("endpoint rejects incomplete, duplicate, and foreign diagnosis permutations without writing", async () => {
  for (const order of [
    ["Condition/confirmed-a", "Condition/confirmed-b"],
    ["Condition/confirmed-a", "Condition/confirmed-b", "Condition/confirmed-b"],
    ["Condition/confirmed-a", "Condition/confirmed-b", "Condition/foreign"],
  ]) {
    const fixture = orderFixture();
    const result = await reorder(fixture, order);
    assert.equal(result.status, 422, order.join(","));
    assert.match(errorMessage(result.body), /exact permutation/i);
    assert.equal(fixture.updateCalls.length, 0);
  }
});

test("a 409 or 412 conditional Encounter conflict is rejected without retry or partial rank persistence", async () => {
  for (const status of [409, 412]) {
    const fixture = orderFixture({ updateError: Object.assign(new Error(`FHIR ${status}`), { status }) });

    const result = await reorder(fixture, [
      "Condition/confirmed-b",
      "Condition/confirmed-a",
      "Condition/provisional-c",
    ]);

    assert.equal(result.status, 409);
    assert.match(errorMessage(result.body), /changed concurrently.*reload and retry/i);
    assert.equal(fixture.updateCalls.length, 1);
    assert.deepEqual(fixture.persistedEncounter.diagnosis?.map((entry) => entry.rank), [1, 2, 3]);
    assert.equal(fixture.persistedEncounter.extension?.[0]?.valueReference?.reference, "Coverage/coverage-1");
  }
});

test("claim draft assembles after reorder with diagnosis and charge-pointer order derived from new ranks", async () => {
  const fixture = orderFixture();
  const result = await reorder(fixture, [
    "Condition/confirmed-b",
    "Condition/confirmed-a",
    "Condition/provisional-c",
  ]);
  assert.equal(result.status, 200);
  const signedEncounter: Encounter = {
    ...structuredClone(fixture.persistedEncounter),
    status: "finished",
    period: { start: "2026-08-12T14:00:00Z", end: "2026-08-12T14:30:00Z" },
  };
  const charge: ChargeItem = {
    resourceType: "ChargeItem",
    id: "charge-b",
    status: "billable",
    code: { coding: [{ system: "urn:synthetic:procedure", code: "PROC-B" }] },
    subject: { reference: "Patient/pat-1" },
    context: { reference: `Encounter/${ENCOUNTER_ID}` },
    supportingInformation: [{ reference: "Condition/confirmed-b" }],
  };
  const coverage: Coverage = {
    resourceType: "Coverage",
    id: "coverage-1",
    status: "active",
    beneficiary: { reference: "Patient/pat-1" },
    order: 1,
    payor: [{ reference: "Organization/synthetic-payer" }],
  };

  const draft = await buildClaimDraft(claimClient(
    signedEncounter,
    [CONFIRMED_A, CONFIRMED_B, PROVISIONAL_C],
    [charge],
    [coverage],
  ), ENCOUNTER_ID, []);

  assert.deepEqual(draft.diagnoses.map((diagnosis) => diagnosis.code), ["DX-B", "DX-A"]);
  assert.deepEqual(draft.charges[0]?.diagnosisSequence, [1]);
});

function orderFixture(options: { updateError?: Error } = {}) {
  const persistedEncounter = encounter();
  const conditions = new Map([
    [CONFIRMED_A.id!, structuredClone(CONFIRMED_A)],
    [CONFIRMED_B.id!, structuredClone(CONFIRMED_B)],
    [PROVISIONAL_C.id!, structuredClone(PROVISIONAL_C)],
  ]);
  const updateCalls: Array<{
    resourceType: "Encounter";
    id: string;
    resource: Encounter;
    headers?: Record<string, string>;
  }> = [];
  const fhir: DiagnosisOrderFhirClient = {
    async read(resourceType, id) {
      if (resourceType === "Encounter") {
        assert.equal(id, ENCOUNTER_ID);
        return structuredClone(persistedEncounter) as never;
      }
      const condition = conditions.get(id);
      if (!condition) throw Object.assign(new Error("FHIR 404"), { status: 404 });
      return structuredClone(condition) as never;
    },
    async update(resourceType, id, resource, headers) {
      assert.equal(resourceType, "Encounter");
      updateCalls.push({
        resourceType,
        id,
        resource: structuredClone(resource),
        ...(headers ? { headers: structuredClone(headers) } : {}),
      });
      if (options.updateError) throw options.updateError;
      Object.assign(persistedEncounter, structuredClone(resource), { meta: { versionId: "8" } });
      return structuredClone(persistedEncounter) as never;
    },
  };
  return { fhir, persistedEncounter, updateCalls };
}

function reorder(
  fixture: ReturnType<typeof orderFixture>,
  conditionReferences: string[],
) {
  return handleDiagnosisOrderRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/clinician",
      actorRole: "clinician",
      fhir: fixture.fhir,
    }),
  }, {
    authHeader: "Bearer synthetic",
    params: { encounterId: ENCOUNTER_ID },
    body: { conditionReferences },
  });
}

function encounter(): Encounter {
  return {
    resourceType: "Encounter",
    id: ENCOUNTER_ID,
    meta: { versionId: "7" },
    status: "in-progress",
    class: {},
    subject: { reference: "Patient/pat-1" },
    extension: [{
      url: "https://odos2020.com/fhir/StructureDefinition/intended-coverage",
      valueReference: { reference: "Coverage/coverage-1" },
    }],
    diagnosis: [
      { condition: { reference: "Condition/confirmed-a" }, rank: 1 },
      { condition: { reference: "Condition/confirmed-b" }, rank: 2 },
      { condition: { reference: "Condition/provisional-c" }, rank: 3 },
    ],
  };
}

function confirmedCondition(id: string, code: string): Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: "Patient/pat-1" },
    encounter: { reference: `Encounter/${ENCOUNTER_ID}` },
    category: [{ coding: [{
      system: FHIR_CONDITION_CATEGORY_CODE_SYSTEM,
      code: "encounter-diagnosis",
    }] }],
    code: { coding: [{ system: "urn:synthetic:diagnosis", code }] },
    verificationStatus: { coding: [{
      system: FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM,
      code: "confirmed",
    }] },
  };
}

function provisionalCondition(id: string, code: string): Condition {
  return {
    ...confirmedCondition(id, code),
    verificationStatus: { coding: [{
      system: FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM,
      code: "provisional",
    }] },
  };
}

function errorMessage(body: unknown): string {
  return typeof body === "object" && body !== null && "error" in body
    ? String((body as { error?: unknown }).error)
    : "";
}

function claimClient(
  encounterResource: Encounter,
  conditionResources: Condition[],
  chargeResources: ChargeItem[],
  coverageResources: Coverage[],
) {
  const resources = new Map<string, Resource>([
    [`Encounter/${encounterResource.id}`, encounterResource],
    ...conditionResources.map((condition) => [`Condition/${condition.id}`, condition] as const),
  ]);
  return {
    async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      const resource = resources.get(`${resourceType}/${id}`);
      if (!resource) throw Object.assign(new Error(`${resourceType}/${id} not found`), { status: 404 });
      return structuredClone(resource) as T;
    },
    async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
      const rows = resourceType === "ChargeItem"
        ? chargeResources
        : resourceType === "Coverage" ? coverageResources : [];
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })),
      };
    },
  };
}
