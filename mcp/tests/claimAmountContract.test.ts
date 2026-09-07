import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type {
  Bundle,
  ChargeItem,
  ChargeItemDefinition,
  Condition,
  Coverage,
  Encounter,
  Resource,
} from "@medplum/fhirtypes";
import {
  buildClaimDraft,
  type EncounterClaimDraft,
} from "../src/claims/claim-draft.js";
import {
  buildClaimMdProfessionalClaimJson,
  buildProfessionalClaim,
  type ProfessionalClaimInput,
} from "../src/claims/claimmd-fhir.js";
import { buildStediProfessionalClaimJson } from "../src/claims/stedi-fhir.js";
import {
  buildProcedureFeeDefinition,
  materializeAcceptedChargeProposals,
  PROCEDURE_LATERALITY_MODIFIER_ELIGIBLE_CONCEPT_KEYS,
} from "../src/clinical-graph/procedure-fee-schedule.js";
import type { ChargeProposal, ProtocolApplication } from "../src/clinical-graph/protocol-types.js";

const SERVICE_DATE = "2026-09-07";
const PROCEDURE_LATERALITY_MODIFIER_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-procedure-laterality-modifier";

test("A: one $10 unit stays a $10 line and claim across draft, FHIR, Claim.MD, and Stedi", async () => {
  const result = await buildAmountWitness([{ id: "line-a", units: 1, unitPriceCents: 1_000 }]);

  assertAmountSurfaces(result, [{ lineCents: 1_000, units: 1, unitCents: 1_000 }], 1_000);
});

test("B: two $10 units stay one $20 line instead of becoming a $40 claim", async () => {
  const result = await buildAmountWitness([{ id: "line-b", units: 2, unitPriceCents: 1_000 }]);

  assertAmountSurfaces(result, [{ lineCents: 2_000, units: 2, unitCents: 1_000 }], 2_000);
});

test("C: a $10 line across three units omits a rounded FHIR unitPrice", async () => {
  const result = await buildAmountWitness([{
    id: "line-c",
    units: 3,
    unitPriceCents: 1_000,
    persistedLineTotalCents: 1_000,
  }]);
  const item = result.claim.item?.[0];
  if (item?.unitPrice?.value !== undefined) {
    assert.equal(
      Math.round(item.unitPrice.value * 100) * 3,
      1_000,
      "an emitted unitPrice must multiply back to the line net in whole cents",
    );
  }

  assertAmountSurfaces(result, [{ lineCents: 1_000, units: 3 }], 1_000);
});

test("D: a two-line claim total is the sum of line totals, never line total times quantity", async () => {
  const result = await buildAmountWitness([
    { id: "line-d1", units: 1, unitPriceCents: 1_000 },
    { id: "line-d2", units: 2, unitPriceCents: 1_000 },
  ]);

  assertAmountSurfaces(result, [
    { lineCents: 1_000, units: 1, unitCents: 1_000 },
    { lineCents: 2_000, units: 2, unitCents: 1_000 },
  ], 3_000);
});

test("B5: an explicitly eligible fixture concept carries OD/OS as RT/LT through both wires", async () => {
  const eligibleConceptKeys = new Set(["synthetic-line-rt", "synthetic-line-lt"]);
  const result = await buildAmountWitness([
    { id: "line-rt", units: 1, unitPriceCents: 1_000, laterality: "OD" },
    { id: "line-lt", units: 1, unitPriceCents: 1_000, laterality: "OS" },
  ], eligibleConceptKeys);

  assert.deepEqual(
    result.input.chargeItems.map(modifierCodes),
    [["RT"], ["LT"]],
  );
  assert.deepEqual(
    result.input.chargeItems.map((chargeItem) => chargeItem.modifierExtension?.[0]?.url),
    [PROCEDURE_LATERALITY_MODIFIER_URL, PROCEDURE_LATERALITY_MODIFIER_URL],
  );
  assert.deepEqual(
    result.claimMd.claim[0]?.charge.map((line) => line.mod1),
    ["RT", "LT"],
  );
  assert.deepEqual(
    result.stedi.claimInformation.serviceLines.map((line) =>
      line.professionalService.procedureModifiers),
    [["RT"], ["LT"]],
  );
});

test("B5: the laterality modifier extension is defined and registered canonically", async () => {
  const directory = resolve(import.meta.dirname, "../../data/canonical-extensions");
  const definition = JSON.parse(await readFile(
    resolve(directory, "odos-procedure-laterality-modifier.json"),
    "utf8",
  )) as { resourceType?: string; url?: string; context?: Array<{ expression?: string }> };
  const registry = JSON.parse(await readFile(resolve(directory, "registry.json"), "utf8")) as {
    extensions?: Array<{ url?: string }>;
  };

  assert.equal(definition.resourceType, "StructureDefinition");
  assert.equal(definition.url, PROCEDURE_LATERALITY_MODIFIER_URL);
  assert.deepEqual(definition.context, [{ type: "element", expression: "ChargeItem" }]);
  assert.ok(registry.extensions?.some((entry) => entry.url === PROCEDURE_LATERALITY_MODIFIER_URL));
});

test("B5: the shipped eligibility allowlist is empty and emits no modifier", async () => {
  assert.deepEqual([...PROCEDURE_LATERALITY_MODIFIER_ELIGIBLE_CONCEPT_KEYS], []);

  const result = await buildAmountWitness([
    { id: "line-gated", units: 1, unitPriceCents: 1_000, laterality: "OD" },
  ]);
  assert.deepEqual(modifierCodes(result.input.chargeItems[0]!), []);
  assert.equal(result.claimMd.claim[0]?.charge[0]?.mod1, undefined);
  assert.equal(
    result.stedi.claimInformation.serviceLines[0]?.professionalService.procedureModifiers,
    undefined,
  );
});

interface AmountWitness {
  draft: EncounterClaimDraft;
  input: ProfessionalClaimInput;
  claim: ReturnType<typeof buildProfessionalClaim>;
  claimMd: ReturnType<typeof buildClaimMdProfessionalClaimJson>;
  stedi: ReturnType<typeof buildStediProfessionalClaimJson>;
}

function assertAmountSurfaces(
  result: AmountWitness,
  expectedLines: Array<{ lineCents: number; units: number; unitCents?: number }>,
  expectedTotalCents: number,
): void {
  assert.deepEqual(
    result.draft.charges.map((line) => ({ feeDollars: line.feeDollars, quantity: line.quantity })),
    expectedLines.map((line) => ({ feeDollars: dollars(line.lineCents), quantity: String(line.units) })),
  );
  assert.deepEqual(
    result.claim.item?.map((item) => ({
      units: item.quantity?.value,
      unitCents: item.unitPrice?.value === undefined ? undefined : Math.round(item.unitPrice.value * 100),
      netCents: item.net?.value === undefined ? undefined : Math.round(item.net.value * 100),
    })),
    expectedLines.map((line) => ({
      units: line.units,
      unitCents: line.unitCents,
      netCents: line.lineCents,
    })),
  );
  assert.equal(Math.round((result.claim.total?.value ?? -1) * 100), expectedTotalCents);
  assert.deepEqual(
    result.claimMd.claim[0]?.charge.map((line) => ({ charge: line.charge, units: line.units })),
    expectedLines.map((line) => ({ charge: dollars(line.lineCents), units: String(line.units) })),
  );
  assert.equal(result.claimMd.claim[0]?.total_charge, dollars(expectedTotalCents));
  assert.equal(result.claimMd.claim[0]?.balance_due, dollars(expectedTotalCents));
  assert.deepEqual(
    result.stedi.claimInformation.serviceLines.map((line) => ({
      charge: line.professionalService.lineItemChargeAmount,
      units: line.professionalService.serviceUnitCount,
    })),
    expectedLines.map((line) => ({ charge: decimal(line.lineCents), units: String(line.units) })),
  );
  assert.equal(result.stedi.claimInformation.claimChargeAmount, decimal(expectedTotalCents));
}

async function buildAmountWitness(lines: Array<{
  id: string;
  units: number;
  unitPriceCents: number;
  persistedLineTotalCents?: number;
  laterality?: "OD" | "OS" | "OU";
}>, modifierEligibleProcedureConceptKeys?: ReadonlySet<string>): Promise<AmountWitness> {
  const encounter: Encounter = {
    resourceType: "Encounter",
    id: "enc-m1a",
    status: "in-progress",
    class: {},
    subject: { reference: "Patient/pat-m1a" },
    period: { start: `${SERVICE_DATE}T09:00:00Z` },
    diagnosis: [{ condition: { reference: "Condition/dx-m1a" }, rank: 1 }],
  };
  const condition: Condition = {
    resourceType: "Condition",
    id: "dx-m1a",
    clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
    verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis" }] }],
    code: { coding: [{ system: "https://odos.test/fhir/CodeSystem/synthetic-diagnosis", code: "DX-M1A" }] },
    subject: { reference: "Patient/pat-m1a" },
    encounter: { reference: "Encounter/enc-m1a" },
  };
  const coverage: Coverage = {
    resourceType: "Coverage",
    id: "cov-m1a",
    status: "active",
    beneficiary: { reference: "Patient/pat-m1a" },
    order: 1,
    payor: [{ reference: "Organization/payer-m1a", identifier: { value: "PAYERTEST" } }],
  };
  const persistedCharges: ChargeItem[] = [];
  const applications = rowStore<ProtocolApplication>([]);

  for (const line of lines) {
    const proposal = acceptedProposal(line.id, line.units, line.laterality);
    const charges = rowStore([proposal]);
    const definition = {
      ...buildProcedureFeeDefinition({
        procedureConceptKey: proposal.procedureConceptKey,
        display: `Synthetic ${line.id}`,
        category: "procedure",
        priceCents: line.unitPriceCents,
        active: true,
      }),
      id: `definition-${line.id}`,
    };
    const materializeInput = {
      fhir: {
        async read() { return structuredClone(encounter); },
        async create(resource) {
          const saved: ChargeItem = {
            ...structuredClone(resource),
            id: line.id,
            ...(line.persistedLineTotalCents === undefined ? {} : {
              priceOverride: { value: line.persistedLineTotalCents / 100, currency: "USD" },
            }),
          };
          persistedCharges.push(saved);
          return structuredClone(saved);
        },
      },
      feeScheduleFhir: feeScheduleFhir(definition),
      encounterId: encounter.id!,
      actorReference: "Practitioner/prov-m1a",
      charges,
      applications,
      now: () => `${SERVICE_DATE}T09:05:00Z`,
      modifierEligibleProcedureConceptKeys,
    };
    await materializeAcceptedChargeProposals(materializeInput);
  }

  encounter.status = "finished";
  encounter.period!.end = `${SERVICE_DATE}T09:30:00Z`;
  const fhir = claimDraftFhir(encounter, condition, coverage, persistedCharges);
  const draft = await buildClaimDraft(fhir, encounter.id!);
  const input = professionalInput(draft, persistedCharges);
  const claim = buildProfessionalClaim(input);
  return {
    draft,
    input,
    claim,
    claimMd: buildClaimMdProfessionalClaimJson(input, claim),
    stedi: buildStediProfessionalClaimJson(input, claim, "test"),
  };
}

function professionalInput(draft: EncounterClaimDraft, charges: ChargeItem[]): ProfessionalClaimInput {
  return {
    created: SERVICE_DATE,
    serviceDate: draft.serviceDate,
    patientReference: draft.patientReference,
    providerReference: "Practitioner/prov-m1a",
    insurerReference: draft.insurerReference!,
    coverageReference: draft.coverageReference!,
    patientAccountNumber: "M1A-WITNESS",
    payerId: draft.payerId!,
    billingProvider: {
      name: "SYNTHETIC PRACTICE",
      npi: "1999999984",
      taxId: "900000001",
      address1: "1 TEST WAY",
      city: "TESTVILLE",
      state: "NY",
      zip: "10001",
      phone: "5555550100",
    },
    renderingProvider: { firstName: "TEST", lastName: "PROVIDER", npi: "1999999984" },
    subscriber: {
      firstName: "TEST",
      lastName: "PATIENT",
      dateOfBirth: "1980-01-01",
      sex: "U",
      memberId: "MEMBER-M1A",
      relationshipCode: "18",
      address1: "2 TEST WAY",
      city: "TESTVILLE",
      state: "NY",
      zip: "10001",
    },
    patient: { firstName: "TEST", lastName: "PATIENT", dateOfBirth: "1980-01-01", sex: "U" },
    diagnoses: draft.diagnoses.map((diagnosis) => ({
      system: diagnosis.system,
      code: diagnosis.code,
      display: diagnosis.description,
    })),
    chargeItems: charges.map((charge) => ({
      ...structuredClone(charge),
      diagnosisSequence: draft.charges.find((line) => line.id === charge.id)!.diagnosisSequence,
    })),
  };
}

function acceptedProposal(
  id: string,
  units: number,
  laterality?: "OD" | "OS" | "OU",
): ChargeProposal {
  return {
    id: `proposal-${id}`,
    encounterId: "enc-m1a",
    planActionRef: `manual-procedure-charge:${id}`,
    procedureConceptKey: `synthetic-${id}`,
    units,
    ...(laterality ? { laterality } : {}),
    dxPointers: ["Condition/dx-m1a"],
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "clinician-entered",
      actor: "Practitioner/prov-m1a",
      at: `${SERVICE_DATE}T09:00:00Z`,
    },
  };
}

function feeScheduleFhir(definition: ChargeItemDefinition) {
  return {
    baseUrl: "http://localhost:8103/",
    async read<T extends Resource>(): Promise<T> { throw new Error("not used"); },
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: [{ resource: definition as T }] };
    },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: [] };
    },
    async create<T extends Resource>(resource: T): Promise<T> { return structuredClone(resource); },
    async update<T extends Resource>(): Promise<T> { throw new Error("not used"); },
  };
}

function claimDraftFhir(
  encounter: Encounter,
  condition: Condition,
  coverage: Coverage,
  charges: ChargeItem[],
) {
  const resources = new Map<string, Resource>([
    [`Encounter/${encounter.id}`, encounter],
    [`Condition/${condition.id}`, condition],
  ]);
  return {
    baseUrl: "http://localhost:8103/",
    async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      const resource = resources.get(`${resourceType}/${id}`);
      if (!resource) throw new Error(`${resourceType}/${id} not found`);
      return structuredClone(resource) as T;
    },
    async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
      const rows = resourceType === "ChargeItem" ? charges : resourceType === "Coverage" ? [coverage] : [];
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })),
      };
    },
  };
}

function rowStore<T extends { id: string }>(seed: T[]) {
  const rows = new Map(seed.map((row) => [row.id, structuredClone(row)]));
  return {
    async list(): Promise<T[]> { return [...rows.values()].map((row) => structuredClone(row)); },
    async save(value: T): Promise<T> {
      rows.set(value.id, structuredClone(value));
      return structuredClone(value);
    },
  };
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function decimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

function modifierCodes(chargeItem: ChargeItem): string[] {
  return chargeItem.modifierExtension
    ?.flatMap((extension) => extension.extension ?? [])
    .flatMap((extension) => extension.valueCode ? [extension.valueCode] : [])
    ?? [];
}
