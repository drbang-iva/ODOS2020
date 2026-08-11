import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItem, Encounter, Resource } from "@medplum/fhirtypes";
import {
  buildProcedureFeeDefinition,
  materializeAcceptedChargeProposals,
} from "../clinical-graph/procedure-fee-schedule.js";
import { ODOS_CHARGE_LATERALITY_SYSTEM } from "../fhir/charge-item-laterality.js";
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
