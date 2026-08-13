import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type {
  Basic,
  Bundle,
  ChargeItem,
  ChargeItemDefinition,
  Condition,
  Encounter,
  Resource,
} from "@medplum/fhirtypes";
import express from "express";
import {
  MANUAL_PROCEDURE_CHARGE_ID_PREFIX,
  handleProcedureChargeCreateRequest,
  handleProcedureChargePatchRequest,
  handleProcedureChargesRequest,
  registerManualProcedureChargeRoutes,
} from "../clinical-graph/manual-procedure-charge-endpoint.js";
import {
  HCPCS_CODE_SYSTEM,
  PROCEDURE_CONCEPT_SYSTEM,
  buildProcedureFeeDefinition,
  listActiveCodedNonVisitProcedureFees,
} from "../clinical-graph/procedure-fee-schedule.js";
import {
  handleProtocolSignCleanupRequest,
  handleVisitChargeMutationRequest,
} from "../clinical-graph/protocol-endpoint.js";
import { PROTOCOL_BASIC_CODES, ProtocolBasicStore } from "../clinical-graph/protocol-store.js";
import type { ChargeProposal } from "../clinical-graph/protocol-types.js";
import { buildProfessionalClaim } from "../claims/claimmd-fhir.js";

const NOW = "2026-08-11T20:00:00.000Z";
const EDITED_AT = "2026-08-11T20:05:00.000Z";

class MemoryFhir {
  resources: Resource[] = [];
  writes: string[] = [];
  private next = 1;

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
    const code = params.code?.split("|");
    if (code?.[1]) {
      rows = rows.filter((row) => resourceCodings(row).some((coding) =>
        coding.system === code[0] && coding.code === code[1]
      ));
    }
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

  async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
    const conditional = headers?.["If-None-Exist"]?.replace(/^identifier=/, "").split("|");
    if (conditional?.[1]) {
      const existing = this.resources.find((row) => resourceIdentifiers(row).some((value) =>
        value.system === conditional[0] && value.value === conditional[1]
      ));
      if (existing) return structuredClone(existing) as T;
    }
    const saved = { ...structuredClone(resource), id: resource.id ?? `resource-${this.next++}` } as T;
    this.resources.push(saved);
    this.writes.push(`create:${logicalId(saved)}`);
    return structuredClone(saved);
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    const index = this.resources.findIndex((row) => row.resourceType === resourceType && row.id === id);
    if (index < 0) throw new Error(`${resourceType}/${id} not found for update`);
    const saved = { ...structuredClone(resource), id } as T;
    this.resources[index] = saved;
    this.writes.push(`update:${logicalId(saved)}`);
    return structuredClone(saved);
  }

  resetWrites(): void {
    this.writes = [];
  }
}

function resourceIdentifiers(resource: Resource): Array<{ system?: string; value?: string }> {
  if (!("identifier" in resource) || !resource.identifier) return [];
  return Array.isArray(resource.identifier) ? resource.identifier : [resource.identifier];
}

function resourceCodings(resource: Resource): Array<{ system?: string; code?: string }> {
  const code = (resource as Resource & { code?: unknown }).code;
  if (!code || typeof code !== "object" || !("coding" in code)) return [];
  const coding = (code as { coding?: unknown }).coding;
  return Array.isArray(coding) ? coding : [];
}

function logicalId(resource: Resource): string {
  return resourceIdentifiers(resource)[0]?.value ?? `${resource.resourceType}/${resource.id ?? "unknown"}`;
}

function chargeProposalBytes(fhir: MemoryFhir): Array<[string, string]> {
  return fhir.resources.flatMap((resource) => {
    if (resource.resourceType !== "Basic" || !resourceCodings(resource).some((coding) =>
      coding.code === PROTOCOL_BASIC_CODES.chargeProposal
    )) return [];
    const id = resourceIdentifiers(resource)[0]?.value;
    const bytes = resource.extension?.find((extension) => extension.valueString)?.valueString;
    return id && bytes ? [[id, bytes] as [string, string]] : [];
  }).sort(([left], [right]) => left.localeCompare(right));
}

function protectedProposalBytes(fhir: MemoryFhir, ids: readonly string[]): Array<[string, string]> {
  const protectedIds = new Set(ids);
  return chargeProposalBytes(fhir).filter(([id]) => protectedIds.has(id));
}

function definition(
  id: string,
  procedureConceptKey: string,
  display: string,
  billingCode: string | undefined,
  active: boolean,
): ChargeItemDefinition {
  return {
    ...buildProcedureFeeDefinition({ procedureConceptKey, display, billingCode, active }),
    id,
  };
}

function encounter(overrides: Partial<Encounter> = {}): Encounter {
  return {
    resourceType: "Encounter",
    id: "enc-1",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    diagnosis: [
      { condition: { reference: "Condition/principal" }, rank: 1 },
      { condition: { reference: "Condition/secondary" }, rank: 2 },
    ],
    ...overrides,
  };
}

function condition(id: string, display: string): Condition {
  return {
    resourceType: "Condition",
    id,
    clinicalStatus: { coding: [{ code: "active" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
    code: { text: display },
    subject: { reference: "Patient/patient-1" },
  };
}

function manualProcedure(overrides: Partial<ChargeProposal> = {}): ChargeProposal {
  const id = overrides.id ?? `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}existing-1`;
  return {
    id,
    encounterId: "enc-1",
    planActionRef: id,
    procedureConceptKey: "gonioscopy",
    units: 1,
    dxPointers: ["Condition/principal"],
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "clinician-entered",
      actor: "Practitioner/clinician",
      at: NOW,
    },
    ...overrides,
  };
}

function visitProposal(overrides: Partial<ChargeProposal> = {}): ChargeProposal {
  return {
    id: "manual-visit-code:enc-1",
    encounterId: "enc-1",
    planActionRef: "manual-visit-code",
    procedureConceptKey: "comprehensive-exam-new",
    units: 1,
    laterality: "OU",
    dxPointers: ["Condition/principal"],
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "clinician-entered",
      actor: "Practitioner/clinician",
      at: NOW,
    },
    ...overrides,
  };
}

function protocolProposal(id: string, overrides: Partial<ChargeProposal> = {}): ChargeProposal {
  return {
    id,
    encounterId: "enc-1",
    protocolApplicationId: `application-${id}`,
    planActionRef: `action-${id}`,
    procedureConceptKey: "gonioscopy",
    units: 1,
    laterality: "OU",
    dxPointers: ["Condition/principal"],
    evidenceRefs: ["Observation/evidence"],
    coverageEvaluations: [],
    state: "staged",
    provenance: {
      source: "protocol-default",
      actor: "Practitioner/clinician",
      at: NOW,
      protocolId: "protocol-1",
      protocolVersion: 1,
    },
    ...overrides,
  };
}

function fixture(input: { encounter?: Encounter; id?: () => string } = {}) {
  const fhir = new MemoryFhir();
  fhir.resources.push(
    input.encounter ?? encounter(),
    condition("principal", "Principal diagnosis"),
    condition("secondary", "Secondary diagnosis"),
    definition("fee-gonioscopy", "gonioscopy", "Gonioscopy", "SYNTHA", true),
    definition("fee-uncoded", "corneal-pachymetry", "Corneal pachymetry", undefined, true),
    definition("fee-inactive", "fundus-photography", "Fundus photography", "SYNTHB", false),
    definition("fee-visit", "comprehensive-exam-new", "Visit", "SYNTHC", true),
  );
  const authenticate = async (authHeader: string | undefined) => {
    if (!authHeader) return null;
    return {
      staffReference: "Practitioner/clinician",
      actorRole: authHeader === "Bearer auditor" ? "auditor" as const : "clinician" as const,
      fhir,
    };
  };
  return {
    fhir,
    deps: {
      authenticate,
      id: input.id ?? (() => "synthetic-1"),
      now: () => NOW,
    },
    store: new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal),
  };
}

async function seed(fhir: MemoryFhir, ...proposals: ChargeProposal[]): Promise<void> {
  const store = new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
  for (const proposal of proposals) await store.save(proposal);
  fhir.resetWrites();
}

function deactivateConcept(fhir: MemoryFhir, procedureConceptKey: string): void {
  const definition = feeDefinition(fhir, procedureConceptKey);
  definition.status = "retired";
}

function clearConceptBillingCode(fhir: MemoryFhir, procedureConceptKey: string): void {
  const definition = feeDefinition(fhir, procedureConceptKey);
  definition.code = {
    ...definition.code,
    coding: definition.code?.coding?.filter((coding) => coding.system === PROCEDURE_CONCEPT_SYSTEM),
  };
}

function feeDefinition(fhir: MemoryFhir, procedureConceptKey: string): ChargeItemDefinition {
  const found = fhir.resources.find((resource): resource is ChargeItemDefinition =>
    resource.resourceType === "ChargeItemDefinition" && resourceCodings(resource).some((coding) =>
      coding.system === PROCEDURE_CONCEPT_SYSTEM && coding.code === procedureConceptKey
    )
  );
  if (!found) throw new Error(`Fee definition ${procedureConceptKey} not found`);
  return found;
}

test("lists only active coded non-visit procedure fees without mutations", async () => {
  const definitions = [
    definition("coded", "gonioscopy", "Gonioscopy", "SYNTHA", true),
    definition("uncoded", "corneal-pachymetry", "Corneal pachymetry", undefined, true),
    definition("inactive", "fundus-photography", "Fundus photography", "SYNTHB", false),
    definition("visit", "comprehensive-exam-new", "Visit", "SYNTHC", true),
    {
      resourceType: "ChargeItemDefinition",
      id: "whitespace-billing-code",
      url: "https://odos2020.com/practice/odos-practice/charge-rules/procedures/synthetic-whitespace",
      status: "active",
      title: "Whitespace billing code",
      code: {
        coding: [
          { system: HCPCS_CODE_SYSTEM, code: "   " },
          { system: PROCEDURE_CONCEPT_SYSTEM, code: "synthetic-whitespace", display: "Whitespace billing code" },
        ],
      },
    } satisfies ChargeItemDefinition,
  ];
  let mutations = 0;
  const fhir = {
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: definitions.map((resource) => ({ resource: resource as T })),
      };
    },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: [] };
    },
    async create(): Promise<never> {
      mutations += 1;
      throw new Error("The option filter must not create fee definitions.");
    },
    async update(): Promise<never> {
      mutations += 1;
      throw new Error("The option filter must not update fee definitions.");
    },
  };

  const options = await listActiveCodedNonVisitProcedureFees(fhir);

  assert.deepEqual(options.map((item) => item.procedureConceptKey), ["gonioscopy"]);
  assert.equal(options[0]?.billingCode, "SYNTHA");
  assert.equal(mutations, 0);
});

test("procedure handlers enforce chart access before any FHIR write", async () => {
  const { deps, fhir } = fixture();
  const calls = [
    () => handleProcedureChargesRequest(deps, {
      authHeader: undefined,
      params: { encounterId: "enc-1" },
    }),
    () => handleProcedureChargeCreateRequest(deps, {
      authHeader: undefined,
      params: { encounterId: "enc-1" },
      body: { procedureConceptKey: "gonioscopy" },
    }),
    () => handleProcedureChargePatchRequest(deps, {
      authHeader: undefined,
      params: { encounterId: "enc-1", proposalId: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}one` },
      body: { state: "removed" },
    }),
  ];
  for (const call of calls) assert.equal((await call()).status, 401);

  const forbiddenCalls = [
    () => handleProcedureChargesRequest(deps, {
      authHeader: "Bearer auditor",
      params: { encounterId: "enc-1" },
    }),
    () => handleProcedureChargeCreateRequest(deps, {
      authHeader: "Bearer auditor",
      params: { encounterId: "enc-1" },
      body: { procedureConceptKey: "gonioscopy" },
    }),
    () => handleProcedureChargePatchRequest(deps, {
      authHeader: "Bearer auditor",
      params: { encounterId: "enc-1", proposalId: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}one` },
      body: { state: "removed" },
    }),
  ];
  for (const call of forbiddenCalls) assert.equal((await call()).status, 403);
  assert.deepEqual(fhir.writes, []);
  assert.deepEqual(chargeProposalBytes(fhir), []);
});

test("procedure read returns the coded option, ranked Encounter diagnoses, and no proposals", async () => {
  const { deps } = fixture({
    encounter: encounter({
      diagnosis: [
        { condition: { reference: "Condition/secondary" }, rank: 2 },
        { condition: { reference: "Condition/principal" }, rank: 1 },
      ],
    }),
  });
  const result = await handleProcedureChargesRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
  });

  assert.deepEqual(result, {
    status: 200,
    body: {
      options: [{
        procedureConceptKey: "gonioscopy",
        display: "Gonioscopy",
        billingCode: "SYNTHA",
      }],
      diagnoses: [
        { reference: "Condition/principal", display: "Principal diagnosis", rank: 1 },
        { reference: "Condition/secondary", display: "Secondary diagnosis", rank: 2 },
      ],
      proposals: [],
      attachedProcedures: [],
    },
  });
});

test("procedure read exposes every active Encounter proposal through its existing diagnosis pointers", async () => {
  const { deps, fhir } = fixture();
  await seed(
    fhir,
    manualProcedure({ id: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}attached`, dxPointers: ["Condition/secondary"] }),
    visitProposal({ dxPointers: ["Condition/principal"] }),
    protocolProposal("protocol-attached", {
      procedureConceptKey: "corneal-pachymetry",
      dxPointers: ["Condition/secondary"],
      state: "accepted",
    }),
    manualProcedure({ id: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}removed`, state: "removed" }),
  );

  const result = await handleProcedureChargesRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
  });

  assert.deepEqual((result.body as { attachedProcedures: unknown }).attachedProcedures, [
    {
      proposalId: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}attached`,
      procedureConceptKey: "gonioscopy",
      display: "Gonioscopy",
      diagnosisReferences: ["Condition/secondary"],
    },
    {
      proposalId: "manual-visit-code:enc-1",
      procedureConceptKey: "comprehensive-exam-new",
      display: "Visit",
      diagnosisReferences: ["Condition/principal"],
    },
    {
      proposalId: "protocol-attached",
      procedureConceptKey: "corneal-pachymetry",
      display: "Corneal pachymetry",
      diagnosisReferences: ["Condition/secondary"],
    },
  ]);
});

test("procedure charge HTTP routes reach GET POST and encoded PATCH handlers", async () => {
  const { deps } = fixture();
  let serviceAuthCalls = 0;
  const app = express();
  app.use(express.json());
  registerManualProcedureChargeRoutes(app, {
    authenticateService: async () => { serviceAuthCalls += 1; },
    authenticateRead: deps.authenticate,
    authenticateWrite: deps.authenticate,
    id: deps.id,
    now: deps.now,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/clinical-graph/protocols/encounters/enc-1/procedure-charges`;
  try {
    const headers = { Authorization: "Bearer clinician", "Content-Type": "application/json" };
    assert.equal((await fetch(base, { headers })).status, 200);
    const created = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ procedureConceptKey: "gonioscopy" }),
    });
    assert.equal(created.status, 201);
    const body = await created.json() as { proposal: ChargeProposal };
    assert.equal(body.proposal.id, `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}synthetic-1`);
    const patched = await fetch(`${base}/${encodeURIComponent(body.proposal.id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ state: "removed" }),
    });
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as { proposal: ChargeProposal }).proposal.state, "removed");
    assert.equal(serviceAuthCalls, 3);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("procedure create uses stable manual identity and the sole principal diagnosis", async () => {
  const { deps, store } = fixture();
  const result = await handleProcedureChargeCreateRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
    body: { procedureConceptKey: "gonioscopy" },
  });
  const proposal = {
    id: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}synthetic-1`,
    encounterId: "enc-1",
    planActionRef: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}synthetic-1`,
    procedureConceptKey: "gonioscopy",
    units: 1,
    dxPointers: ["Condition/principal"],
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "clinician-entered",
      actor: "Practitioner/clinician",
      at: NOW,
    },
  } satisfies ChargeProposal;

  assert.deepEqual(result, { status: 201, body: { proposal } });
  assert.deepEqual(await store.get(proposal.id), proposal);
  assert.equal(Object.hasOwn(proposal, "laterality"), false);
  assert.equal(Object.hasOwn(proposal, "protocolApplicationId"), false);
});

for (const diagnosis of [
  [],
  [
    { condition: { reference: "Condition/principal" }, rank: 1 },
    { condition: { reference: "Condition/secondary" }, rank: 1 },
  ],
] satisfies Encounter["diagnosis"][]) {
  test(`procedure create defaults to no diagnosis for ${diagnosis.length} principal rows`, async () => {
    const { deps } = fixture({ encounter: encounter({ diagnosis }) });
    const result = await handleProcedureChargeCreateRequest(deps, {
      authHeader: "Bearer clinician",
      params: { encounterId: "enc-1" },
      body: { procedureConceptKey: "gonioscopy" },
    });
    assert.deepEqual((result.body as { proposal: ChargeProposal }).proposal.dxPointers, []);
  });
}

for (const [name, procedureConceptKey] of [
  ["active-but-uncoded", "corneal-pachymetry"],
  ["inactive-coded", "fundus-photography"],
  ["active-coded visit", "comprehensive-exam-new"],
  ["unknown", "unknown-concept"],
] as const) {
  test(`procedure POST rejects ${name} concept with no collateral write`, async () => {
    const { deps, fhir } = fixture();
    const before = chargeProposalBytes(fhir);
    const result = await handleProcedureChargeCreateRequest(deps, {
      authHeader: "Bearer clinician",
      params: { encounterId: "enc-1" },
      body: { procedureConceptKey },
    });

    assert.equal(result.status, 400);
    assert.deepEqual(fhir.writes, []);
    assert.deepEqual(chargeProposalBytes(fhir), before);
  });
}

test("procedure patch edits, clears, removes, and revives only mutable fields", async () => {
  const { deps, fhir, store } = fixture();
  const id = `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}synthetic-1`;
  const lastAmendment = { actor: "Practitioner/clinician", at: NOW };
  await seed(fhir, manualProcedure({ id }));
  const patch = (body: {
    laterality?: "OD" | "OS" | "OU" | null;
    dxPointer?: string | null;
    state?: "accepted" | "removed";
  }) => handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: id },
    body,
  });

  assert.equal((await patch({ laterality: "OD", dxPointer: "Condition/secondary" })).status, 200);
  assert.deepEqual(await store.get(id), manualProcedure({
    id,
    laterality: "OD",
    dxPointers: ["Condition/secondary"],
    lastAmendment,
  }));
  assert.equal((await patch({ laterality: null, dxPointer: null })).status, 200);
  assert.deepEqual(await store.get(id), manualProcedure({ id, dxPointers: [], lastAmendment }));
  assert.equal((await patch({ state: "removed" })).status, 200);
  assert.deepEqual(await store.get(id), manualProcedure({ id, dxPointers: [], state: "removed", lastAmendment }));
  assert.equal((await patch({ state: "accepted" })).status, 200);
  assert.deepEqual(await store.get(id), manualProcedure({ id, dxPointers: [], state: "accepted", lastAmendment }));
});

test("procedure patch preserves creation attribution and records the last amendment", async () => {
  const { deps } = fixture();
  const created = await handleProcedureChargeCreateRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
    body: { procedureConceptKey: "gonioscopy" },
  });
  const proposal = (created.body as { proposal: ChargeProposal }).proposal;
  const editorDeps = {
    ...deps,
    authenticate: async (authHeader: string | undefined) => {
      const staff = await deps.authenticate(authHeader);
      return staff ? { ...staff, staffReference: "Practitioner/editor" } : null;
    },
    now: () => EDITED_AT,
  };

  const edited = await handleProcedureChargePatchRequest(editorDeps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: proposal.id },
    body: { laterality: "OD" },
  });
  const editedProposal = (edited.body as { proposal: ChargeProposal }).proposal;

  assert.deepEqual(editedProposal.provenance, {
    source: "clinician-entered",
    actor: "Practitioner/clinician",
    at: NOW,
  });
  assert.deepEqual(editedProposal.lastAmendment, {
    actor: "Practitioner/editor",
    at: EDITED_AT,
  });
});

test("deactivated procedure can still be removed", async () => {
  const { deps, fhir, store } = fixture();
  const id = `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}deactivated-remove`;
  await seed(fhir, manualProcedure({ id }));
  deactivateConcept(fhir, "gonioscopy");

  const removed = await handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: id },
    body: { state: "removed" },
  });
  assert.equal(removed.status, 200);
  assert.equal((await store.get(id))?.state, "removed");
});

test("sign cleanup does not materialize a deactivated procedure after removal", async () => {
  const { deps, fhir } = fixture();
  const id = `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}deactivated-sign`;
  await seed(fhir, manualProcedure({ id }));
  deactivateConcept(fhir, "gonioscopy");
  const removed = await handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: id },
    body: { state: "removed" },
  });
  assert.equal(removed.status, 200);

  fhir.resetWrites();
  const signed = await handleProtocolSignCleanupRequest({
    authenticate: deps.authenticate,
    feeScheduleFhir: fhir,
    now: deps.now,
  }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
  });
  assert.deepEqual(signed, {
    status: 200,
    body: { abandoned: 0, materialized: 0, finalized: 0 },
  });
  assert.equal(fhir.resources.some((resource) => resource.resourceType === "ChargeItem"), false);
});

test("uncoded procedure can still be removed", async () => {
  const { deps, fhir, store } = fixture();
  const id = `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}uncoded-remove`;
  await seed(fhir, manualProcedure({ id }));
  clearConceptBillingCode(fhir, "gonioscopy");

  const removed = await handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: id },
    body: { state: "removed" },
  });
  assert.equal(removed.status, 200);
  assert.equal((await store.get(id))?.state, "removed");
});

test("deactivated procedure rejects laterality edits with no write", async () => {
  const { deps, fhir } = fixture();
  const id = `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}deactivated-edit`;
  await seed(fhir, manualProcedure({ id }));
  deactivateConcept(fhir, "gonioscopy");
  const before = chargeProposalBytes(fhir);

  const result = await handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: id },
    body: { laterality: "OD" },
  });
  assert.equal(result.status, 409);
  assert.deepEqual(fhir.writes, []);
  assert.deepEqual(chargeProposalBytes(fhir), before);
});

test("deactivated removed procedure rejects revival with no write", async () => {
  const { deps, fhir } = fixture();
  const id = `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}deactivated-revive`;
  await seed(fhir, manualProcedure({ id, state: "removed" }));
  deactivateConcept(fhir, "gonioscopy");
  const before = chargeProposalBytes(fhir);

  const result = await handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: id },
    body: { state: "accepted" },
  });
  assert.equal(result.status, 409);
  assert.deepEqual(fhir.writes, []);
  assert.deepEqual(chargeProposalBytes(fhir), before);
});

test("procedure lifecycle leaves the visit and every protocol proposal byte-identical", async () => {
  const { deps, fhir } = fixture();
  const protectedIds = ["manual-visit-code:enc-1", "protocol-one", "protocol-two"];
  await seed(
    fhir,
    visitProposal(),
    protocolProposal("protocol-one"),
    protocolProposal("protocol-two", { state: "accepted" }),
  );
  const before = protectedProposalBytes(fhir, protectedIds);
  const created = await handleProcedureChargeCreateRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
    body: { procedureConceptKey: "gonioscopy" },
  });
  const procedureId = (created.body as { proposal: ChargeProposal }).proposal.id;
  assert.deepEqual(protectedProposalBytes(fhir, protectedIds), before);

  for (const body of [
    { laterality: "OS" as const, dxPointer: "Condition/secondary" },
    { state: "removed" as const },
    { state: "accepted" as const },
  ]) {
    assert.equal((await handleProcedureChargePatchRequest(deps, {
      authHeader: "Bearer clinician",
      params: { encounterId: "enc-1", proposalId: procedureId },
      body,
    })).status, 200);
    assert.deepEqual(protectedProposalBytes(fhir, protectedIds), before);
  }
});

test("visit change and removal leave every manual procedure and protocol proposal byte-identical", async () => {
  const { deps, fhir } = fixture();
  const protectedIds = [
    `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}one`,
    `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}two`,
    "protocol-one",
    "protocol-two",
  ];
  await seed(
    fhir,
    visitProposal(),
    manualProcedure({ id: protectedIds[0] }),
    manualProcedure({ id: protectedIds[1], laterality: "OS", dxPointers: [] }),
    protocolProposal("protocol-one"),
    protocolProposal("protocol-two", { state: "accepted" }),
  );
  const before = protectedProposalBytes(fhir, protectedIds);

  assert.equal((await handleVisitChargeMutationRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
    body: { procedureConceptKey: "intermediate-exam-established" },
  })).status, 200);
  assert.deepEqual(protectedProposalBytes(fhir, protectedIds), before);

  assert.equal((await handleVisitChargeMutationRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
    body: { procedureConceptKey: null },
  })).status, 200);
  assert.deepEqual(protectedProposalBytes(fhir, protectedIds), before);
});

test("procedure PATCH rejects visit identity and leaves the visit proposal unchanged", async () => {
  const { deps, fhir } = fixture();
  const visit = visitProposal();
  await seed(fhir, visit, manualProcedure(), protocolProposal("protocol-collateral"));
  const before = chargeProposalBytes(fhir);

  const result = await handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: visit.id },
    body: { state: "removed" },
  });

  assert.equal(result.status, 409);
  assert.deepEqual(chargeProposalBytes(fhir), before);
});

const identityGuardCases: Array<{
  name: string;
  target: ChargeProposal;
  encounterId?: string;
}> = [
  {
    name: "wrong prefix",
    target: manualProcedure({ id: "wrong-prefix", planActionRef: "wrong-prefix" }),
  },
  {
    name: "foreign encounter",
    target: manualProcedure({
      id: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}foreign`,
      encounterId: "enc-foreign",
      planActionRef: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}foreign`,
    }),
  },
  {
    name: "protocol-generated target",
    target: manualProcedure({
      id: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}protocol-owned`,
      planActionRef: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}protocol-owned`,
      protocolApplicationId: "application-1",
    }),
  },
  {
    name: "planActionRef mismatch",
    target: manualProcedure({
      id: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}mismatched-action`,
      planActionRef: "different-action",
    }),
  },
  {
    name: "visit concept",
    target: manualProcedure({
      id: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}visit-concept`,
      planActionRef: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}visit-concept`,
      procedureConceptKey: "comprehensive-exam-new",
    }),
  },
];

for (const guard of identityGuardCases) {
  test(`procedure PATCH rejects ${guard.name} with zero writes and byte-identical collateral`, async () => {
    const { deps, fhir } = fixture();
    await seed(
      fhir,
      guard.target,
      visitProposal(),
      manualProcedure({ id: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}collateral` }),
      protocolProposal("protocol-collateral"),
    );
    const before = chargeProposalBytes(fhir);

    const result = await handleProcedureChargePatchRequest(deps, {
      authHeader: "Bearer clinician",
      params: { encounterId: guard.encounterId ?? "enc-1", proposalId: guard.target.id },
      body: { state: "removed" },
    });

    assert.equal(result.status, 409);
    assert.deepEqual(fhir.writes, []);
    assert.deepEqual(chargeProposalBytes(fhir), before);
  });
}

for (const [name, target, body] of [
  [
    "finalized proposal",
    manualProcedure({
      id: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}finalized`,
      state: "finalized",
      chargeItemRef: "ChargeItem/finalized",
    }),
    { state: "removed" },
  ],
  [
    "foreign diagnosis",
    manualProcedure({ id: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}foreign-diagnosis` }),
    { dxPointer: "Condition/not-on-encounter" },
  ],
  [
    "empty change",
    manualProcedure({ id: `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}empty-change` }),
    {},
  ],
] as const) {
  test(`procedure PATCH rejects ${name} before any collateral write`, async () => {
    const { deps, fhir } = fixture();
    await seed(fhir, target, visitProposal(), protocolProposal("protocol-collateral"));
    const before = chargeProposalBytes(fhir);

    const result = await handleProcedureChargePatchRequest(deps, {
      authHeader: "Bearer clinician",
      params: { encounterId: "enc-1", proposalId: target.id },
      body,
    });

    assert.ok(result.status === 400 || result.status === 409);
    assert.deepEqual(fhir.writes, []);
    assert.deepEqual(chargeProposalBytes(fhir), before);
  });
}

test("behavioral acceptance: one visit and three procedure charges stay isolated through claim build", async () => {
  let nextProcedureId = 0;
  const { deps, fhir, store } = fixture({
    encounter: encounter({
      period: { start: NOW },
      diagnosis: [
        { condition: { reference: "Condition/principal" }, rank: 1 },
        { condition: { reference: "Condition/bilateral" }, rank: 2 },
        { condition: { reference: "Condition/tertiary" }, rank: 3 },
      ],
    }),
    id: () => `acceptance-${++nextProcedureId}`,
  });
  fhir.resources.push(
    {
      ...condition("bilateral", "Bilateral diagnosis"),
      bodySite: [{ text: "OU" }],
    },
    condition("tertiary", "Tertiary diagnosis"),
    definition(
      "fee-intermediate-established",
      "intermediate-exam-established",
      "Intermediate established visit",
      "SYNTHD",
      true,
    ),
  );
  const pachymetry = feeDefinition(fhir, "corneal-pachymetry");
  pachymetry.code = {
    ...pachymetry.code,
    coding: [
      { system: HCPCS_CODE_SYSTEM, code: "SYNTHB", display: "Synthetic procedure B" },
      ...(pachymetry.code?.coding ?? []),
    ],
  };
  const photography = feeDefinition(fhir, "fundus-photography");
  photography.status = "active";
  const protocol = protocolProposal("protocol-acceptance");
  await seed(fhir, protocol);
  const protocolSnapshot = structuredClone(protocol);
  const assertProtocolUnchanged = async () => {
    assert.deepEqual(await store.get(protocol.id), protocolSnapshot);
  };

  const visitCreated = await handleVisitChargeMutationRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
    body: { procedureConceptKey: "comprehensive-exam-new" },
  });
  assert.equal(visitCreated.status, 200);
  await assertProtocolUnchanged();

  const procedureIds: string[] = [];
  for (const procedureConceptKey of ["gonioscopy", "corneal-pachymetry", "fundus-photography"]) {
    const created = await handleProcedureChargeCreateRequest(deps, {
      authHeader: "Bearer clinician",
      params: { encounterId: "enc-1" },
      body: { procedureConceptKey },
    });
    assert.equal(created.status, 201);
    procedureIds.push((created.body as { proposal: ChargeProposal }).proposal.id);
    await assertProtocolUnchanged();
  }
  const [odProcedureId, selectedPointerProcedureId, revivedProcedureId] = procedureIds as [string, string, string];

  assert.equal((await handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: odProcedureId },
    body: { laterality: "OD", dxPointer: "Condition/bilateral" },
  })).status, 200);
  await assertProtocolUnchanged();
  assert.equal((await handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: selectedPointerProcedureId },
    body: { dxPointer: "Condition/tertiary" },
  })).status, 200);
  assert.deepEqual((await store.get(selectedPointerProcedureId))?.dxPointers, ["Condition/tertiary"]);
  await assertProtocolUnchanged();

  const unaffectedByRemoval = ["manual-visit-code:enc-1", odProcedureId, selectedPointerProcedureId, protocol.id];
  const beforeRemoval = protectedProposalBytes(fhir, unaffectedByRemoval);
  const revivedBeforeRemoval = await store.get(revivedProcedureId);
  assert.ok(revivedBeforeRemoval);
  assert.equal((await handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: revivedProcedureId },
    body: { state: "removed" },
  })).status, 200);
  assert.deepEqual(protectedProposalBytes(fhir, unaffectedByRemoval), beforeRemoval);
  assert.deepEqual(await store.get(revivedProcedureId), {
    ...revivedBeforeRemoval,
    state: "removed",
    lastAmendment: { actor: "Practitioner/clinician", at: NOW },
  });
  await assertProtocolUnchanged();

  const beforeRevival = protectedProposalBytes(fhir, unaffectedByRemoval);
  const removedBeforeRevival = await store.get(revivedProcedureId);
  assert.ok(removedBeforeRevival);
  assert.equal((await handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1", proposalId: revivedProcedureId },
    body: { state: "accepted" },
  })).status, 200);
  assert.deepEqual(protectedProposalBytes(fhir, unaffectedByRemoval), beforeRevival);
  assert.deepEqual(await store.get(revivedProcedureId), {
    ...removedBeforeRevival,
    state: "accepted",
    lastAmendment: { actor: "Practitioner/clinician", at: NOW },
  });
  await assertProtocolUnchanged();

  const visitBeforeChange = await store.get("manual-visit-code:enc-1");
  assert.ok(visitBeforeChange);
  const protectedBeforeVisitChange = protectedProposalBytes(fhir, [...procedureIds, protocol.id]);
  assert.equal((await handleVisitChargeMutationRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
    body: { procedureConceptKey: "intermediate-exam-established" },
  })).status, 200);
  assert.deepEqual(protectedProposalBytes(fhir, [...procedureIds, protocol.id]), protectedBeforeVisitChange);
  assert.deepEqual(await store.get("manual-visit-code:enc-1"), {
    ...visitBeforeChange,
    procedureConceptKey: "intermediate-exam-established",
  });
  await assertProtocolUnchanged();

  const acceptedManual = (await store.list()).filter((proposal) =>
    proposal.encounterId === "enc-1" &&
    proposal.state === "accepted" &&
    (proposal.protocolApplicationId === undefined || proposal.protocolApplicationId === null)
  );
  assert.equal(acceptedManual.length, 4);
  assert.equal(acceptedManual.filter((proposal) => proposal.id === "manual-visit-code:enc-1").length, 1);
  assert.equal(acceptedManual.filter((proposal) => proposal.id.startsWith(MANUAL_PROCEDURE_CHARGE_ID_PREFIX)).length, 3);
  assert.ok(acceptedManual.every((proposal) => {
    const fee = feeDefinition(fhir, proposal.procedureConceptKey);
    return fee.status === "active" && resourceCodings(fee).some((coding) =>
      coding.system === HCPCS_CODE_SYSTEM && Boolean(coding.code?.trim())
    );
  }));

  const beforeChargeCount = fhir.resources.filter((resource) => resource.resourceType === "ChargeItem").length;
  const signed = await handleProtocolSignCleanupRequest({
    authenticate: deps.authenticate,
    feeScheduleFhir: fhir,
    now: deps.now,
  }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
  });
  assert.deepEqual(signed, {
    status: 200,
    body: { abandoned: 0, materialized: 4, finalized: 4 },
  });
  const chargeItems = fhir.resources.filter((resource): resource is ChargeItem =>
    resource.resourceType === "ChargeItem"
  );
  assert.equal(chargeItems.length - beforeChargeCount, 4);
  await assertProtocolUnchanged();

  const chargeForProposal = (proposalId: string) => chargeItems.find((chargeItem) =>
    resourceIdentifiers(chargeItem).some((identifier) => identifier.value === proposalId)
  );
  const odCharge = chargeForProposal(odProcedureId);
  assert.ok(odCharge?.id);
  assert.equal(odCharge.bodysite?.[0]?.coding?.[0]?.code, "OD");
  assert.deepEqual(odCharge.supportingInformation, [{ reference: "Condition/bilateral" }]);
  assert.ok(chargeItems.every((chargeItem) => resourceCodings(chargeItem).some((coding) =>
    coding.system === HCPCS_CODE_SYSTEM && Boolean(coding.code?.trim())
  )));

  const diagnosisSequenceByReference = new Map([
    ["Condition/principal", 1],
    ["Condition/bilateral", 2],
    ["Condition/tertiary", 3],
  ]);
  const claim = buildProfessionalClaim({
    created: "2026-08-11",
    serviceDate: "2026-08-11",
    patientReference: "Patient/patient-1",
    providerReference: "Practitioner/clinician",
    insurerReference: "Organization/payer",
    coverageReference: "Coverage/coverage",
    patientAccountNumber: "SYNTHETIC-ACCEPTANCE",
    payerId: "SYNTHETIC",
    billingProvider: { name: "Synthetic practice", npi: "1111111112" },
    renderingProvider: { name: "Synthetic clinician", npi: "1111111112" },
    subscriber: { firstName: "Test", lastName: "Patient", dateOfBirth: "1980-01-01", sex: "U" },
    patient: { firstName: "Test", lastName: "Patient", dateOfBirth: "1980-01-01", sex: "U" },
    diagnoses: [
      { system: "https://example.test/diagnosis", code: "DX-A" },
      { system: "https://example.test/diagnosis", code: "DX-B" },
      { system: "https://example.test/diagnosis", code: "DX-C" },
    ],
    chargeItems: chargeItems.map((chargeItem) => ({
      ...chargeItem,
      diagnosisSequence: (chargeItem.supportingInformation ?? []).flatMap((reference) => {
        const sequence = reference.reference ? diagnosisSequenceByReference.get(reference.reference) : undefined;
        return sequence === undefined ? [] : [sequence];
      }),
    })),
  });
  const odClaimItem = claim.item?.find((item) => item.extension?.some((extension) =>
    extension.valueReference?.reference === `ChargeItem/${odCharge.id}`
  ));
  assert.equal(odClaimItem?.bodySite?.text, "OD");
});
