import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Bundle,
  ChargeItem,
  Condition,
  Coverage,
  Encounter,
  Resource,
} from "@medplum/fhirtypes";
import {
  buildProcedureFeeDefinition,
  materializeAcceptedChargeProposals,
} from "../clinical-graph/procedure-fee-schedule.js";
import { buildClaimDraft, type EncounterClaimDraft } from "../claims/claim-draft.js";
import {
  buildProfessionalClaim,
  type ProfessionalClaimInput,
} from "../claims/claimmd-fhir.js";
import {
  chargeItemBodysite,
  chargeItemLaterality,
  ODOS_CHARGE_LATERALITY_SYSTEM,
} from "../fhir/charge-item-laterality.js";
import type { ChargeProposal, ProtocolApplication } from "../clinical-graph/protocol-types.js";

function rowStore<T extends { id: string }>(seed: T[]) {
  const rows = new Map(seed.map((row) => [row.id, structuredClone(row)]));
  return {
    async list(): Promise<T[]> { return [...rows.values()].map((row) => structuredClone(row)); },
    async save(value: T): Promise<T> {
      rows.set(value.id, structuredClone(value));
      return structuredClone(value);
    },
    async get(id: string): Promise<T | undefined> {
      const value = rows.get(id);
      return value ? structuredClone(value) : undefined;
    },
  };
}

function acceptedManualProposal(overrides: Partial<ChargeProposal> = {}): ChargeProposal {
  return {
    id: "proposal-1",
    encounterId: "enc-1",
    planActionRef: "manual-procedure-charge:proposal-1",
    procedureConceptKey: "gonioscopy",
    units: 1,
    laterality: "OU",
    dxPointers: ["Condition/dx-1"],
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "clinician-entered",
      actor: "Practitioner/clinician",
      at: "2026-08-11T20:00:00.000Z",
    },
    ...overrides,
  };
}

function protocolApplication(overrides: Partial<ProtocolApplication> = {}): ProtocolApplication {
  return {
    id: "application-1",
    encounterId: "enc-1",
    patientId: "patient-1",
    protocolId: "protocol-1",
    protocolVersion: 1,
    appliedBy: "Practitioner/clinician",
    appliedAt: "2026-08-11T20:00:00.000Z",
    stackedWith: [],
    dispositions: [],
    dedupResolutions: [],
    undoState: "active",
    confirmed: true,
    ...overrides,
  };
}

function lateralityFixture(proposal: ChargeProposal, applications: ProtocolApplication[] = []) {
  const charges = rowStore([proposal]);
  const applicationStore = rowStore(applications);
  const createdChargeItems: ChargeItem[] = [];
  const definition = {
    ...buildProcedureFeeDefinition({
      procedureConceptKey: proposal.procedureConceptKey,
      display: "Synthetic procedure",
      billingCode: "SYNTHA",
      active: true,
    }),
    id: "definition-1",
  };
  const chargeFhir = {
    async read() {
      return {
        resourceType: "Encounter",
        id: "enc-1",
        status: "in-progress",
        class: {},
        subject: { reference: "Patient/patient-1" },
      } satisfies Encounter;
    },
    async create(resource: ChargeItem) {
      const saved = { ...structuredClone(resource), id: `charge-${createdChargeItems.length + 1}` };
      createdChargeItems.push(saved);
      return structuredClone(saved);
    },
  };
  const feeScheduleFhir = {
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: [{ resource: definition as T }] };
    },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: [] };
    },
    async read<T extends Resource>(): Promise<T> { throw new Error("not used"); },
    async create<T extends Resource>(resource: T): Promise<T> {
      return structuredClone({ ...resource, id: resource.id ?? `generated-${resource.resourceType}` });
    },
    async update<T extends Resource>(): Promise<T> { throw new Error("not used"); },
  };
  return {
    createdChargeItems,
    charges,
    input: {
      fhir: chargeFhir,
      feeScheduleFhir,
      encounterId: "enc-1",
      actorReference: "Practitioner/clinician",
      charges,
      applications: applicationStore,
      now: () => "2026-08-11T20:00:00.000Z",
    },
  };
}

for (const [laterality, expected] of [
  ["OD", "OD"],
  ["OS", "OS"],
  ["OU", "OU"],
] as const) {
  test(`materializes ${laterality} proposal laterality into ChargeItem bodysite`, async () => {
    const proposal = acceptedManualProposal({ id: `proposal-${laterality}`, laterality });
    const fixture = lateralityFixture(proposal);
    await materializeAcceptedChargeProposals(fixture.input);
    const created = fixture.createdChargeItems[0];
    assert.equal(created?.bodysite?.[0]?.coding?.[0]?.system, ODOS_CHARGE_LATERALITY_SYSTEM);
    assert.equal(created?.bodysite?.[0]?.coding?.[0]?.code, expected);
    assert.equal(created?.bodysite?.[0]?.text, expected);
    assert.equal((await fixture.charges.get(proposal.id))?.state, "finalized");
  });
}

test("materializes laterality while preserving a confirmed protocol application link", async () => {
  const application = protocolApplication();
  const proposal = acceptedManualProposal({
    protocolApplicationId: application.id,
    laterality: "OS",
  });
  const fixture = lateralityFixture(proposal, [application]);
  await materializeAcceptedChargeProposals(fixture.input);
  assert.equal(fixture.createdChargeItems[0]?.bodysite?.[0]?.coding?.[0]?.code, "OS");
  const finalized = await fixture.charges.get(proposal.id);
  assert.equal(finalized?.protocolApplicationId, application.id);
  assert.equal(finalized?.state, "finalized");
});

test("materializes an unset proposal without ChargeItem bodysite", async () => {
  const { laterality: _laterality, ...withoutLaterality } = acceptedManualProposal({
    id: "proposal-unset",
  });
  const proposal: ChargeProposal = withoutLaterality;
  const fixture = lateralityFixture(proposal);
  await materializeAcceptedChargeProposals(fixture.input);
  assert.equal(fixture.createdChargeItems[0]?.bodysite, undefined);
});

test("serializes one exact ChargeItem bodysite entry", () => {
  assert.deepEqual(chargeItemBodysite("OD"), [{
    coding: [{ system: ODOS_CHARGE_LATERALITY_SYSTEM, code: "OD" }],
    text: "OD",
  }]);
});

test("ignores absent and unknown ChargeItem bodysite values", () => {
  assert.deepEqual(chargeItemLaterality({}), { conflict: false });
  assert.deepEqual(chargeItemLaterality({
    bodysite: [{
      coding: [{ system: "https://example.test/laterality", code: "OD" }],
      text: "unknown",
    }],
  }), { conflict: false });
});

test("normalizes recognized ChargeItem bodysite text", () => {
  assert.deepEqual(chargeItemLaterality({ bodysite: [{ text: "  os  " }] }), {
    laterality: "OS",
    conflict: false,
  });
});

test("deduplicates repeated recognized ChargeItem bodysite values", () => {
  assert.deepEqual(chargeItemLaterality({
    bodysite: [
      ...chargeItemBodysite("OU"),
      { text: "ou" },
    ],
  }), { laterality: "OU", conflict: false });
});

test("reports conflicting recognized ChargeItem bodysite values", () => {
  assert.deepEqual(chargeItemLaterality({
    bodysite: [...chargeItemBodysite("OD"), ...chargeItemBodysite("OS")],
  }), { conflict: true });
});

function signedClaimFixture(input: {
  diagnosisBodySite: "OD" | "OS" | "OU";
  chargeBodySite?: ChargeItem["bodysite"];
}) {
  const encounter: Encounter = {
    resourceType: "Encounter",
    id: "enc-claim",
    status: "finished",
    class: {},
    subject: { reference: "Patient/patient-1" },
    period: { start: "2026-08-11T20:00:00.000Z" },
    diagnosis: [{ condition: { reference: "Condition/dx-1" }, rank: 1 }],
  };
  const condition: Condition = {
    resourceType: "Condition",
    id: "dx-1",
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: "Encounter/enc-claim" },
    verificationStatus: { coding: [{
      system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
      code: "confirmed",
    }] },
    category: [{ coding: [{
      system: "http://terminology.hl7.org/CodeSystem/condition-category",
      code: "encounter-diagnosis",
    }] }],
    code: { coding: [{ system: "https://example.test/diagnosis", code: "DX-A" }] },
    bodySite: [{ text: input.diagnosisBodySite }],
  };
  const charge: ChargeItem = {
    resourceType: "ChargeItem",
    id: "charge-1",
    status: "billable",
    code: { coding: [{ system: "https://example.test/procedure", code: "PROC-A" }] },
    subject: { reference: "Patient/patient-1" },
    context: { reference: "Encounter/enc-claim" },
    supportingInformation: [{ reference: "Condition/dx-1" }],
    priceOverride: { value: 10, currency: "USD" },
    ...(input.chargeBodySite ? { bodysite: input.chargeBodySite } : {}),
  };
  const coverage: Coverage = {
    resourceType: "Coverage",
    id: "coverage-1",
    status: "active",
    beneficiary: { reference: "Patient/patient-1" },
    order: 1,
    payor: [{ reference: "Organization/payer", identifier: { value: "SYNTHETIC" } }],
  };
  const resources = new Map<string, Resource>([
    ["Encounter/enc-claim", encounter],
    ["Condition/dx-1", condition],
  ]);
  const fhir = {
    async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      const resource = resources.get(`${resourceType}/${id}`);
      if (!resource) throw new Error(`${resourceType}/${id} not found`);
      return structuredClone(resource) as T;
    },
    async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
      const rows = resourceType === "ChargeItem" ? [charge] : resourceType === "Coverage" ? [coverage] : [];
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: rows.map((resource) => ({ resource: resource as T })),
      };
    },
  };
  return {
    fhir,
    encounter,
    charge,
    professionalInput(draft: EncounterClaimDraft): ProfessionalClaimInput {
      return {
        created: "2026-08-11",
        serviceDate: draft.serviceDate,
        patientReference: draft.patientReference,
        providerReference: "Practitioner/clinician",
        insurerReference: "Organization/payer",
        coverageReference: "Coverage/coverage-1",
        patientAccountNumber: "SYNTHETIC",
        payerId: "SYNTHETIC",
        billingProvider: { name: "Synthetic practice", npi: "1111111112" },
        renderingProvider: { name: "Synthetic clinician", npi: "1111111112" },
        subscriber: { firstName: "Test", lastName: "Patient", dateOfBirth: "1980-01-01", sex: "U" },
        patient: { firstName: "Test", lastName: "Patient", dateOfBirth: "1980-01-01", sex: "U" },
        diagnoses: draft.diagnoses.map((row) => ({ system: row.system, code: row.code })),
        chargeItems: [{ ...charge, diagnosisSequence: draft.charges[0]!.diagnosisSequence }],
      };
    },
  };
}

test("uses performed OD bodysite when the linked diagnosis is bilateral", async () => {
  const fixture = signedClaimFixture({
    diagnosisBodySite: "OU",
    chargeBodySite: chargeItemBodysite("OD"),
  });
  const draft = await buildClaimDraft(fixture.fhir, fixture.encounter.id!);
  assert.equal(draft.charges[0]?.laterality, "OD");
  const claim = buildProfessionalClaim(fixture.professionalInput(draft));
  assert.equal(claim.item?.[0]?.bodySite?.text, "OD");
});

test("does not inherit diagnosis laterality when ChargeItem bodysite is absent", async () => {
  const fixture = signedClaimFixture({ diagnosisBodySite: "OS" });
  const draft = await buildClaimDraft(fixture.fhir, fixture.encounter.id!);
  assert.equal(draft.charges[0]?.laterality, undefined);
  assert.equal(draft.warnings, undefined);
});

test("warns only when ChargeItem bodysite contains conflicting laterality values", async () => {
  const fixture = signedClaimFixture({
    diagnosisBodySite: "OU",
    chargeBodySite: [...chargeItemBodysite("OD"), ...chargeItemBodysite("OS")],
  });
  const draft = await buildClaimDraft(fixture.fhir, fixture.encounter.id!);
  assert.equal(draft.charges[0]?.laterality, undefined);
  assert.deepEqual(draft.warnings, [
    `ChargeItem/${fixture.charge.id} omitted laterality because bodysite contains conflicting laterality values.`,
  ]);
});

test("does not warn when ChargeItem bodysite has zero recognized laterality values", async () => {
  const fixture = signedClaimFixture({
    diagnosisBodySite: "OU",
    chargeBodySite: [{
      coding: [{ system: ODOS_CHARGE_LATERALITY_SYSTEM, code: "unknown" }],
      text: "unknown",
    }],
  });
  const draft = await buildClaimDraft(fixture.fhir, fixture.encounter.id!);
  assert.equal(draft.charges[0]?.laterality, undefined);
  assert.equal(draft.warnings, undefined);
});
