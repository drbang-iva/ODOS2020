import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Bundle,
  ChargeItem,
  ChargeItemDefinition,
  Encounter,
  Resource,
} from "@medplum/fhirtypes";
import {
  buildProcedureFeeDefinition,
  createProcedureFeeScheduleItem,
  materializeAcceptedChargeProposals,
  saveProcedureFeeScheduleItem,
} from "../clinical-graph/procedure-fee-schedule.js";
import {
  handleProcedureFeeScheduleCreateRequest,
  handleProcedureFeeScheduleMutationRequest,
} from "../clinical-graph/procedure-fee-schedule-endpoint.js";
import type { ChargeProposal, ProtocolApplication } from "../clinical-graph/protocol-types.js";
import {
  buildProfessionalClaim,
  type ProfessionalClaimInput,
} from "../claims/claimmd-fhir.js";

class MemoryFhir {
  readonly baseUrl = "http://localhost:8103/";
  resources: Resource[] = [];
  createCount = 0;
  updateCount = 0;
  next = 1;

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) throw new Error(`${resourceType}/${id} not found`);
    return structuredClone(resource) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    let rows = this.resources.filter((row) => row.resourceType === resourceType);
    const identifier = params.identifier?.split("|");
    if (identifier?.[1]) {
      rows = rows.filter((row) => resourceIdentifiers(row).some((value) =>
        value.system === identifier[0] && value.value === identifier[1]
      ));
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })),
    };
  }

  async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    this.createCount += 1;
    const saved = { ...structuredClone(resource), id: resource.id ?? `resource-${this.next++}` } as T;
    this.resources.push(saved);
    return structuredClone(saved);
  }

  async createWithOutcome<T extends Resource>(resource: T): Promise<{ resource: T; created: boolean }> {
    return { resource: await this.create(resource), created: true };
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    this.updateCount += 1;
    const index = this.resources.findIndex((row) => row.resourceType === resourceType && row.id === id);
    if (index < 0) throw new Error(`${resourceType}/${id} not found for update`);
    const saved = { ...structuredClone(resource), id } as T;
    this.resources[index] = saved;
    return structuredClone(saved);
  }
}

function resourceIdentifiers(resource: Resource): Array<{ system?: string; value?: string }> {
  if (!("identifier" in resource) || !resource.identifier) return [];
  return Array.isArray(resource.identifier) ? resource.identifier : [resource.identifier];
}

function seededFhir(): MemoryFhir {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    ...buildProcedureFeeDefinition({
      procedureConceptKey: "gonioscopy",
      display: "Gonioscopy",
      category: "procedure",
      active: true,
    }),
    id: "fee-gonioscopy",
  });
  return fhir;
}

function authenticatedDeps(fhir: MemoryFhir) {
  return {
    authenticate: async () => ({
      staffReference: "Practitioner/admin",
      actorRole: "admin" as const,
      fhir,
    }),
  };
}

function rowStore<T extends { id: string }>(initial: T[]) {
  let rows = structuredClone(initial);
  return {
    async list(): Promise<T[]> { return structuredClone(rows); },
    async save(value: T): Promise<T> {
      const index = rows.findIndex((row) => row.id === value.id);
      if (index < 0) rows.push(structuredClone(value));
      else rows[index] = structuredClone(value);
      return structuredClone(value);
    },
  };
}

function acceptedProposal(procedureConceptKey: string): ChargeProposal {
  return {
    id: "proposal-synthetic-modifier",
    encounterId: "enc-synthetic-modifier",
    planActionRef: "manual-procedure-charge:proposal-synthetic-modifier",
    procedureConceptKey,
    units: 1,
    dxPointers: [],
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "clinician-entered",
      actor: "Practitioner/clinician",
      at: "2026-08-12T12:00:00.000Z",
    },
  };
}

function claimInput(chargeItem: ChargeItem): ProfessionalClaimInput {
  return {
    created: "2026-08-12",
    serviceDate: "2026-08-12",
    patientReference: "Patient/patient-synthetic",
    providerReference: "Practitioner/clinician",
    insurerReference: "Organization/payer-synthetic",
    coverageReference: "Coverage/coverage-synthetic",
    patientAccountNumber: "SYNTHETIC-ACCOUNT",
    payerId: "SYNTHETIC-PAYER",
    billingProvider: { name: "SYNTHETIC PRACTICE", npi: "1111111112" },
    renderingProvider: { firstName: "TEST", lastName: "CLINICIAN", npi: "1111111112" },
    subscriber: {
      firstName: "TEST",
      lastName: "PATIENT",
      dateOfBirth: "1980-01-01",
      sex: "U",
    },
    patient: {
      firstName: "TEST",
      lastName: "PATIENT",
      dateOfBirth: "1980-01-01",
      sex: "U",
    },
    diagnoses: [{ system: "https://odos.test/diagnosis", code: "SYNTHDX" }],
    chargeItems: [{ ...chargeItem, diagnosisSequence: [1] }],
  };
}

test("fee concept create rejects RT LT and 50 because side comes from the charge", async () => {
  // Removing any denylist member must make this test fail by allowing a concept write.
  for (const modifier of ["RT", "LT", "50"]) {
    const fhir = new MemoryFhir();
    await assert.rejects(
      () => createProcedureFeeScheduleItem(fhir, {
        display: `Synthetic ${modifier} procedure`,
        category: "procedure",
        modifier,
        active: true,
      }),
      new RegExp(`${modifier}.*Side comes from the charge.*ChargeItem\\.bodysite`, "i"),
    );
    assert.equal(fhir.createCount, 0);
    assert.equal(fhir.updateCount, 0);
  }
});

test("fee concept save rejects RT LT and 50 before any update", async () => {
  // Moving laterality validation after update must make this test fail on write counts and resource equality.
  for (const modifier of ["RT", "LT", "50"]) {
    const fhir = seededFhir();
    const before = structuredClone(fhir.resources);
    await assert.rejects(
      () => saveProcedureFeeScheduleItem(fhir, {
        procedureConceptKey: "gonioscopy",
        modifier,
        active: true,
      }),
      /Side comes from the charge.*ChargeItem\.bodysite/i,
    );
    assert.deepEqual(fhir.resources, before);
    assert.equal(fhir.createCount, 0);
    assert.equal(fhir.updateCount, 0);
  }
});

test("fee schedule endpoints return 400 for laterality modifiers on create and save", async () => {
  // Dropping focused input-error handling must make these requests throw or return a non-400 status.
  const createFhir = new MemoryFhir();
  const created = await handleProcedureFeeScheduleCreateRequest(authenticatedDeps(createFhir), {
    authHeader: "Bearer admin",
    body: {
      action: "create",
      display: "Synthetic fixed-side service",
      category: "procedure",
      modifier: "RT",
      priceCents: null,
      active: true,
    },
  });
  assert.equal(created.status, 400);
  assert.match(JSON.stringify(created.body), /Side comes from the charge/);
  assert.equal(createFhir.createCount, 0);

  const saveFhir = seededFhir();
  const saved = await handleProcedureFeeScheduleMutationRequest(authenticatedDeps(saveFhir), {
    authHeader: "Bearer admin",
    params: { procedureConceptKey: "gonioscopy" },
    body: { action: "save", modifier: "LT", priceCents: null, active: true },
  });
  assert.equal(saved.status, 400);
  assert.match(JSON.stringify(saved.body), /Side comes from the charge/);
  assert.equal(saveFhir.updateCount, 0);
});

test("a legitimate synthetic modifier round-trips but remains absent from ChargeItem and Claim", async () => {
  // Projecting the stored modifier into a charge or claim must make this storage-only contract test fail.
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-synthetic-modifier",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-synthetic" },
  } satisfies Encounter);
  const created = await createProcedureFeeScheduleItem(fhir, {
    display: "Synthetic component service",
    category: "procedure",
    billingCode: "SYNTHCOMP",
    modifier: "SYNTHMOD",
    active: true,
  });
  assert.equal(created.modifier, "SYNTHMOD");

  await materializeAcceptedChargeProposals({
    fhir,
    feeScheduleFhir: fhir,
    encounterId: "enc-synthetic-modifier",
    actorReference: "Practitioner/clinician",
    charges: rowStore([acceptedProposal(created.procedureConceptKey)]),
    applications: rowStore<ProtocolApplication>([]),
    now: () => "2026-08-12T12:00:00.000Z",
  });
  const chargeItem = fhir.resources.find((row): row is ChargeItem => row.resourceType === "ChargeItem");
  assert.ok(chargeItem);
  assert.equal(JSON.stringify(chargeItem).includes("SYNTHMOD"), false);
  assert.equal(JSON.stringify(buildProfessionalClaim(claimInput(chargeItem))).includes("SYNTHMOD"), false);
});

test("seeded display or category save returns 400 and leaves the definition byte-equivalent", async () => {
  // Restoring the seeded-value coalescing no-op must make this test fail with status 200.
  for (const attempted of [{ display: "Ignored display" }, { category: "exam" as const }]) {
    const fhir = seededFhir();
    const before = structuredClone(fhir.resources);
    const result = await handleProcedureFeeScheduleMutationRequest(authenticatedDeps(fhir), {
      authHeader: "Bearer admin",
      params: { procedureConceptKey: "gonioscopy" },
      body: { action: "save", ...attempted, priceCents: null, active: true },
    });
    assert.equal(result.status, 400);
    assert.match(JSON.stringify(result.body), /seeded/i);
    assert.deepEqual(fhir.resources, before);
    assert.equal(fhir.createCount, 0);
    assert.equal(fhir.updateCount, 0);
  }
});

test("ordinary fee worksheet create and save persist recorded-only routing", async () => {
  // Omitting routing from either ordinary endpoint schema must return 400 and make this test red.
  const fhir = new MemoryFhir();
  const created = await handleProcedureFeeScheduleCreateRequest(authenticatedDeps(fhir), {
    authHeader: "Bearer admin",
    body: {
      action: "create",
      display: "Synthetic routed service",
      category: "procedure",
      billingCode: "SYNTHROUTE",
      routing: "self-pay",
      priceCents: null,
      active: true,
    },
  });
  assert.equal(created.status, 201);
  const key = (created.body as { item: { procedureConceptKey: string } }).item.procedureConceptKey;
  const saved = await handleProcedureFeeScheduleMutationRequest(authenticatedDeps(fhir), {
    authHeader: "Bearer admin",
    params: { procedureConceptKey: key },
    body: {
      action: "save",
      routing: "insurance-billable",
      priceCents: null,
      active: true,
    },
  });
  assert.equal(saved.status, 200);
  assert.equal((saved.body as { item: { routing?: string } }).item.routing, "insurance-billable");
});
