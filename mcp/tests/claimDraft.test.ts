import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItem, Condition, Coverage, Encounter, Resource } from "@medplum/fhirtypes";
import { buildClaimDraft, ClaimDraftAssemblyError } from "../src/claims/claim-draft.js";

const encounter: Encounter = {
  resourceType: "Encounter",
  id: "enc-1",
  status: "finished",
  class: {},
  subject: { reference: "Patient/pat-1" },
  period: { start: "2026-07-21T14:30:00Z", end: "2026-07-21T15:00:00Z" },
  diagnosis: [
    { condition: { reference: "Condition/dx-b" }, rank: 2 },
    { condition: { reference: "Condition/dx-possible" }, rank: 3 },
    { condition: { reference: "Condition/dx-a" }, rank: 1 },
  ],
};

const conditions: Condition[] = [
  diagnosis("dx-a", "DX-A", "OD"),
  diagnosis("dx-b", "DX-B", "OS"),
  diagnosis("dx-possible", "DX-P", "OU", "provisional"),
];

const charges: ChargeItem[] = [
  {
    resourceType: "ChargeItem",
    id: "charge-entered-in-error",
    status: "entered-in-error",
    code: { coding: [{ system: "urn:ama:cpt", code: "DO-NOT-BILL" }] },
    subject: { reference: "Patient/pat-1" },
    context: { reference: "Encounter/enc-1" },
  },
  {
    resourceType: "ChargeItem",
    id: "charge-b",
    status: "billable",
    code: { coding: [{ system: "urn:ama:cpt", code: "PROC-B", display: "Procedure B" }] },
    subject: { reference: "Patient/pat-1" },
    context: { reference: "Encounter/enc-1" },
    supportingInformation: [{ reference: "Condition/dx-b" }],
    quantity: { value: 1 },
    priceOverride: { value: 75, currency: "USD" },
  },
  {
    resourceType: "ChargeItem",
    id: "charge-both",
    status: "billable",
    code: { coding: [{ system: "https://bluebutton.cms.gov/resources/codesystem/hcpcs", code: "PROC-BOTH" }] },
    subject: { reference: "Patient/pat-1" },
    context: { reference: "Encounter/enc-1" },
    supportingInformation: [
      { reference: "Condition/dx-a" },
      { reference: "Observation/evidence" },
      { reference: "Condition/dx-b" },
    ],
    quantity: { value: 2 },
    priceOverride: { value: 50.5, currency: "USD" },
  },
];

const coverages: Coverage[] = [
  coverage("secondary", 2),
  coverage("primary", 1),
];

test("buildClaimDraft reads ranked confirmed diagnoses and real per-charge pointers from a signed encounter", async () => {
  const searches: Array<{ resourceType: string; params: Record<string, string> }> = [];
  const draft = await buildClaimDraft(client(searches), "enc-1");

  assert.deepEqual(draft.diagnoses.map(({ code }) => code), ["DX-A", "DX-B"]);
  assert.deepEqual(draft.charges[0], {
    id: "charge-b",
    codeType: "CPT",
    codeSystem: "urn:ama:cpt",
    code: "PROC-B",
    description: "Procedure B",
    feeDollars: "75.00",
    quantity: "1",
    diagnosisSequence: [2],
    laterality: "OS",
  });
  assert.deepEqual(draft.charges[1].diagnosisSequence, [1, 2]);
  assert.equal(draft.charges[1].laterality, undefined);
  assert.equal(draft.coverageReference, "Coverage/primary");
  assert.equal(draft.insurerReference, "Organization/payer-primary");
  assert.equal(draft.payerId, "PAYER-primary");
  assert.equal(draft.serviceDate, "2026-07-21");
  assert.deepEqual(draft.warnings, [
    "ChargeItem/charge-both omitted laterality because its linked confirmed diagnoses have conflicting body-site text.",
  ]);
  assert.deepEqual(searches, [
    { resourceType: "ChargeItem", params: { context: "Encounter/enc-1", _count: "100" } },
    { resourceType: "Coverage", params: { beneficiary: "Patient/pat-1", _count: "100" } },
  ]);
});

test("claim assembly never promotes an order-two Coverage while another Coverage record remains", async () => {
  const inactivePrimary = { ...coverage("inactive-primary", 1), status: "cancelled" as const };
  const activeSecondary = coverage("active-secondary", 2);
  await assert.rejects(
    buildClaimDraft(
      client([], encounter, [inactivePrimary, activeSecondary]),
      "enc-1",
    ),
    /only active Coverage is not recorded as primary \(order 1\)/,
  );
});

test("claim assembly uses the active order-one Coverage when other payers are present", async () => {
  const draft = await buildClaimDraft(
    client([], encounter, [coverage("secondary", 2), coverage("primary", 1), coverage("tertiary", 3)]),
    "enc-1",
  );

  assert.equal(draft.coverageReference, "Coverage/primary");
});

test("claim assembly accepts one lone active Coverage when its order is omitted", async () => {
  const unorderedCoverage = coverage("only-payer", 1);
  delete unorderedCoverage.order;
  const draft = await buildClaimDraft(client([], encounter, [unorderedCoverage]), "enc-1");

  assert.equal(draft.coverageReference, "Coverage/only-payer");
});

test("claim assembly rejects multiple active Coverages when none is recorded as primary", async () => {
  await assert.rejects(
    buildClaimDraft(
      client([], encounter, [coverage("secondary", 2), coverage("tertiary", 3)]),
      "enc-1",
    ),
    /multiple active Coverages but none recorded as primary \(order 1\)/,
  );
});

test("buildClaimDraft rejects a payerless draft when no active Coverage exists", async () => {
  await assert.rejects(
    buildClaimDraft(
      client([], encounter, [{ ...coverage("inactive-primary", 1), status: "cancelled" }]),
      "enc-1",
    ),
    /no active Coverage/,
  );
});

test("buildClaimDraft excludes a billable charge without a confirmed diagnosis and surfaces a warning", async () => {
  const unlinkedCharge = {
    ...charges[1]!,
    id: "charge-unlinked",
    supportingInformation: [{ reference: "Condition/dx-possible" }],
  };
  const draft = await buildClaimDraft(client([], encounter, coverages, [unlinkedCharge]), "enc-1");

  assert.equal(draft.charges.length, 0);
  assert.deepEqual(draft.warnings, [
    "ChargeItem/charge-unlinked was excluded because it has no linked confirmed encounter diagnosis.",
  ]);
});

test("buildClaimDraft converts missing Encounter and Condition reads into assembly errors", async () => {
  await assert.rejects(
    buildClaimDraft(client([]), "missing"),
    ClaimDraftAssemblyError,
  );

  const missingCondition = structuredClone(encounter);
  missingCondition.diagnosis![0]!.condition.reference = "Condition/missing";
  await assert.rejects(
    buildClaimDraft(client([], missingCondition), "enc-1"),
    ClaimDraftAssemblyError,
  );

  const upstreamFailure = Object.assign(new Error("upstream route not found"), { status: 502 });
  await assert.rejects(
    buildClaimDraft({
      ...client([]),
      async read<T extends Resource>(): Promise<T> {
        throw upstreamFailure;
      },
    }, "enc-1"),
    (error: unknown) => error === upstreamFailure,
  );
});

test("buildClaimDraft refuses unsigned encounters and unsafe diagnosis ranks", async () => {
  const unsigned = structuredClone(encounter);
  unsigned.status = "in-progress";
  await assert.rejects(buildClaimDraft(client([], unsigned), "enc-1"), ClaimDraftAssemblyError);

  const duplicate = structuredClone(encounter);
  duplicate.diagnosis![1]!.rank = 2;
  await assert.rejects(
    buildClaimDraft(client([], duplicate), "enc-1"),
    /duplicate diagnosis ranks/,
  );

  const duplicateCondition = structuredClone(encounter);
  duplicateCondition.diagnosis![1]!.condition.reference = duplicateCondition.diagnosis![0]!.condition.reference;
  await assert.rejects(
    buildClaimDraft(client([], duplicateCondition), "enc-1"),
    /duplicate diagnosis Condition references/,
  );

  const unranked = structuredClone(encounter);
  delete unranked.diagnosis![0]!.rank;
  await assert.rejects(
    buildClaimDraft(client([], unranked), "enc-1"),
    /positive integer rank/,
  );

  const missingReference = structuredClone(encounter);
  delete missingReference.diagnosis![0]!.condition.reference;
  await assert.rejects(
    buildClaimDraft(client([], missingReference), "enc-1"),
    /missing its Condition reference/,
  );
});

function client(
  searches: Array<{ resourceType: string; params: Record<string, string> }>,
  encounterResource = encounter,
  coverageResources = coverages,
  chargeResources = charges,
) {
  const resources = new Map<string, Resource>([
    ["Encounter/enc-1", encounterResource],
    ...conditions.map((condition) => [`Condition/${condition.id}`, condition] as const),
  ]);
  return {
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      const resource = resources.get(`${resourceType}/${id}`);
      if (!resource) throw Object.assign(new Error(`${resourceType}/${id} not found`), { status: 404 });
      return resource as T;
    },
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => {
      searches.push({ resourceType, params });
      const matching = resourceType === "ChargeItem" ? chargeResources : resourceType === "Coverage" ? coverageResources : [];
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: matching.map((resource) => ({ resource: resource as T })),
      };
    },
  };
}

function diagnosis(
  id: string,
  code: string,
  laterality: string,
  verification: "confirmed" | "provisional" = "confirmed",
): Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: "Patient/pat-1" },
    encounter: { reference: "Encounter/enc-1" },
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis" }] }],
    verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: verification }] },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code, display: `Diagnosis ${code}` }] },
    bodySite: [{ text: laterality }],
  };
}

function coverage(id: string, order: number): Coverage {
  return {
    resourceType: "Coverage",
    id,
    status: "active",
    beneficiary: { reference: "Patient/pat-1" },
    order,
    payor: [{ reference: `Organization/payer-${id}`, identifier: { value: `PAYER-${id}` } }],
  };
}
