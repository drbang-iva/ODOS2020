import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItemDefinition, Encounter, Resource } from "@medplum/fhirtypes";
import {
  PROCEDURE_FEE_SEEDS,
  buildProcedureFeeDefinition,
  listProcedureFeeSchedule,
  materializeAcceptedChargeProposals,
  saveProcedureFeeScheduleItem,
} from "../clinical-graph/procedure-fee-schedule.js";
import type { ChargeProposal, ProtocolApplication } from "../clinical-graph/protocol-types.js";
import {
  handleVisitChargeMutationRequest,
  handleVisitChargeRequest,
} from "../clinical-graph/protocol-endpoint.js";
import { PROTOCOL_BASIC_CODES, ProtocolBasicStore } from "../clinical-graph/protocol-store.js";

class MemoryFhir {
  resources: Resource[] = [];
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
    if (conditional?.[1] && "identifier" in resource) {
      const existing = this.resources.find((row) => resourceIdentifiers(row).some((value) =>
        value.system === conditional[0] && value.value === conditional[1]
      ));
      if (existing) return structuredClone(existing) as T;
    }
    const saved = { ...structuredClone(resource), id: resource.id ?? `resource-${this.next++}` } as T;
    this.resources.push(saved);
    return structuredClone(saved);
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    const saved = { ...structuredClone(resource), id } as T;
    const index = this.resources.findIndex((row) => row.resourceType === resourceType && row.id === id);
    if (index < 0) throw new Error(`${resourceType}/${id} not found for update`);
    this.resources[index] = saved;
    return structuredClone(saved);
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

const VISIT_KEYS = [
  "comprehensive-exam-new",
  "comprehensive-exam-established",
  "intermediate-exam-new",
  "intermediate-exam-established",
  "office-visit-new-straightforward",
  "office-visit-new-low",
  "office-visit-new-moderate",
  "office-visit-established-straightforward",
  "office-visit-established-low",
  "office-visit-established-moderate",
  "routine-vision-exam-new",
  "routine-vision-exam-established",
] as const;

const NOW = "2026-08-11T15:00:00.000Z";

function chargeProposal(overrides: Partial<ChargeProposal> = {}): ChargeProposal {
  return {
    id: "proposal-1",
    encounterId: "enc-1",
    protocolApplicationId: "application-1",
    planActionRef: "charge-gonioscopy",
    procedureConceptKey: "gonioscopy",
    units: 1,
    laterality: "OU",
    dxPointers: ["Condition/dx-1"],
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "protocol-default",
      actor: "Practitioner/doc",
      at: NOW,
      protocolId: "protocol-1",
      protocolVersion: 1,
    },
    ...overrides,
  };
}

function manualChargeProposal(overrides: Partial<ChargeProposal> = {}): ChargeProposal {
  const { protocolApplicationId: _application, ...manual } = chargeProposal(overrides);
  return manual as ChargeProposal;
}

function rowStore<T extends { id: string }>(initial: T[]) {
  let rows = structuredClone(initial);
  return {
    async list() { return structuredClone(rows); },
    async save(value: T) {
      const index = rows.findIndex((row) => row.id === value.id);
      if (index === -1) rows.push(structuredClone(value));
      else rows[index] = structuredClone(value);
      return structuredClone(value);
    },
  };
}

function protocolApplication(overrides: Partial<ProtocolApplication> = {}): ProtocolApplication {
  return {
    id: "application-1",
    encounterId: "enc-1",
    patientId: "patient-1",
    protocolId: "protocol-1",
    protocolVersion: 1,
    appliedBy: "Practitioner/doc",
    appliedAt: NOW,
    stackedWith: [],
    dispositions: [],
    dedupResolutions: [],
    undoState: "active",
    confirmed: true,
    ...overrides,
  };
}

test("the shipped fee schedule contains 12 visit concepts and settings-only refraction", () => {
  assert.equal(PROCEDURE_FEE_SEEDS.length, 18);
  assert.deepEqual(
    PROCEDURE_FEE_SEEDS.slice(5).map((row) => row.procedureConceptKey),
    [...VISIT_KEYS, "refraction"],
  );
  assert.deepEqual(
    PROCEDURE_FEE_SEEDS.flatMap((row) => row.billingCode
      ? [[row.procedureConceptKey, row.billingCode] as const]
      : []),
    [
      ["routine-vision-exam-new", "S0620"],
      ["routine-vision-exam-established", "S0621"],
    ],
  );
});

test("billing coding is positionally first while the ODOS concept remains system-addressable", () => {
  const definition = buildProcedureFeeDefinition({
    procedureConceptKey: "routine-vision-exam-new",
    display: "Routine vision exam — new patient",
    billingCode: "S0620",
  });
  assert.deepEqual(definition.code?.coding, [
    {
      system: "https://bluebutton.cms.gov/resources/codesystem/hcpcs",
      code: "S0620",
      display: "Routine vision exam — new patient",
    },
    {
      system: "https://odos2020.com/fhir/CodeSystem/procedure-concept",
      code: "routine-vision-exam-new",
      display: "Routine vision exam — new patient",
    },
  ]);
});

test("billing code save normalizes, preserves on omission, and removes on blank", async () => {
  const fhir = new MemoryFhir();
  assert.equal((await listProcedureFeeSchedule(fhir)).length, 18);
  assert.equal(fhir.resources.filter((row) => row.resourceType === "ChargeItemDefinition").length, 5);
  const normalized = await saveProcedureFeeScheduleItem(fhir, {
    procedureConceptKey: "comprehensive-exam-new",
    billingCode: "  a1b2  ",
    priceCents: 18_500,
    active: true,
  });
  assert.equal(normalized.billingCode, "A1B2");
  assert.equal(normalized.priceCents, 18_500);

  const preserved = await saveProcedureFeeScheduleItem(fhir, {
    procedureConceptKey: "comprehensive-exam-new",
    priceCents: 19_000,
    active: false,
  });
  assert.equal(preserved.billingCode, "A1B2");
  assert.equal(preserved.priceCents, 19_000);
  assert.equal(preserved.active, false);

  const removed = await saveProcedureFeeScheduleItem(fhir, {
    procedureConceptKey: "comprehensive-exam-new",
    billingCode: "   ",
    active: true,
  });
  assert.equal(removed.billingCode, undefined);
  assert.equal(removed.priceCents, 19_000);

  const definitions = fhir.resources.filter((row): row is ChargeItemDefinition =>
    row.resourceType === "ChargeItemDefinition"
  );
  assert.equal(definitions.length, 6);
});

test("manual proposals materialize without weakening non-linkage validation", async () => {
  const validFhir = new MemoryFhir();
  validFhir.resources.push({
    resourceType: "Encounter",
    id: "enc-1",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
  } satisfies Encounter);
  const validStore = rowStore([manualChargeProposal()]);
  assert.deepEqual(await materializeAcceptedChargeProposals({
    fhir: validFhir,
    feeScheduleFhir: validFhir,
    encounterId: "enc-1",
    actorReference: "Practitioner/doc",
    charges: validStore,
    applications: rowStore<ProtocolApplication>([]),
    now: () => NOW,
  }), { materialized: 1, finalized: 1 });
  assert.equal(validFhir.resources.filter((row) => row.resourceType === "ChargeItem").length, 1);

  const invalidCases: Array<[Partial<ChargeProposal>, RegExp]> = [
    [{ units: 0 }, /invalid units/],
    [{ procedureConceptKey: "INVALID" }, /invalid procedure concept key/],
    [{ dxPointers: ["Observation/not-a-diagnosis"] }, /invalid diagnosis pointer/],
  ];
  for (const [overrides, expected] of invalidCases) {
    const fhir = new MemoryFhir();
    fhir.resources.push({
      resourceType: "Encounter",
      id: "enc-1",
      status: "in-progress",
      class: { code: "AMB" },
      subject: { reference: "Patient/patient-1" },
    } satisfies Encounter);
    await assert.rejects(() => materializeAcceptedChargeProposals({
      fhir,
      feeScheduleFhir: fhir,
      encounterId: "enc-1",
      actorReference: "Practitioner/doc",
      charges: rowStore([manualChargeProposal(overrides)]),
      applications: rowStore<ProtocolApplication>([]),
      now: () => NOW,
    }), expected);
    assert.equal(fhir.resources.some((row) => row.resourceType === "ChargeItem"), false);
  }
});

test("populated application ids remain strict and chargeItemRef remains idempotent", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-1",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
  } satisfies Encounter);
  for (const protocolApplicationId of ["missing-application", ""]) {
    await assert.rejects(() => materializeAcceptedChargeProposals({
      fhir,
      feeScheduleFhir: fhir,
      encounterId: "enc-1",
      actorReference: "Practitioner/doc",
      charges: rowStore([chargeProposal({ protocolApplicationId })]),
      applications: rowStore([protocolApplication()]),
      now: () => NOW,
    }), /not linked to an active confirmed application/);
  }

  const skippedStore = rowStore([manualChargeProposal({ chargeItemRef: "ChargeItem/existing" })]);
  assert.deepEqual(await materializeAcceptedChargeProposals({
    fhir,
    feeScheduleFhir: fhir,
    encounterId: "enc-1",
    actorReference: "Practitioner/doc",
    charges: skippedStore,
    applications: rowStore<ProtocolApplication>([]),
    now: () => NOW,
  }), { materialized: 0, finalized: 1 });
  assert.equal((await skippedStore.list())[0]?.state, "finalized");
  assert.equal(fhir.resources.some((row) => row.resourceType === "ChargeItem"), false);
});

test("visit charge handlers enforce chart access and create one stable manual proposal", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-visit",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    diagnosis: [{ condition: { reference: "Condition/principal" }, rank: 1 }],
  } satisfies Encounter);
  const authenticate = async (header: string | undefined) => header === "Bearer clinician"
    ? { staffReference: "Practitioner/doc", actorRole: "clinician" as const, fhir }
    : header === "Bearer front"
      ? { staffReference: "Practitioner/front", actorRole: "front-desk" as const, fhir }
      : header === "Bearer auditor"
        ? { staffReference: "Practitioner/auditor", actorRole: "auditor" as const, fhir }
      : null;

  assert.equal((await handleVisitChargeRequest({ authenticate }, {
    authHeader: undefined,
    params: { encounterId: "enc-visit" },
  })).status, 401);
  assert.equal((await handleVisitChargeRequest({ authenticate }, {
    authHeader: "Bearer auditor",
    params: { encounterId: "enc-visit" },
  })).status, 403);
  assert.equal((await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer front",
    params: { encounterId: "enc-visit" },
    body: { procedureConceptKey: "routine-vision-exam-new" },
  })).status, 403);

  const initial = await handleVisitChargeMutationRequest({ authenticate, now: () => NOW }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-visit" },
    body: { procedureConceptKey: "routine-vision-exam-new" },
  });
  assert.equal(initial.status, 200);
  const proposal = (initial.body as { proposal: ChargeProposal }).proposal;
  assert.deepEqual(proposal, {
    id: "manual-visit-code:enc-visit",
    encounterId: "enc-visit",
    planActionRef: "manual-visit-code",
    procedureConceptKey: "routine-vision-exam-new",
    units: 1,
    laterality: "OU",
    dxPointers: ["Condition/principal"],
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "clinician-entered",
      actor: "Practitioner/doc",
      at: NOW,
    },
  });
  assert.equal(Object.hasOwn(proposal, "protocolApplicationId"), false);

  const store = new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
  assert.deepEqual(await store.list(), [proposal]);
  const read = await handleVisitChargeRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-visit" },
  });
  assert.equal(read.status, 200);
  const body = read.body as {
    selectedProcedureConceptKey?: string;
    options: Array<{ procedureConceptKey: string; billingCode?: string }>;
  };
  assert.equal(body.selectedProcedureConceptKey, "routine-vision-exam-new");
  assert.equal(body.options.length, 12);
  assert.equal(body.options.some((option) => option.procedureConceptKey === "refraction"), false);
  assert.equal(body.options.find((option) => option.procedureConceptKey === "routine-vision-exam-new")?.billingCode, "S0620");
});

test("multiple or malformed principal diagnoses default to an empty editable pointer list", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-multiple-principal",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    diagnosis: [
      { condition: { reference: "Condition/one" }, rank: 1 },
      { condition: { reference: "Condition/two" }, rank: 1 },
    ],
  } satisfies Encounter, {
    resourceType: "Encounter",
    id: "enc-malformed-principal",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    diagnosis: [{ condition: { reference: "Observation/not-a-condition" }, rank: 1 }],
  } satisfies Encounter);
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "clinician" as const,
    fhir,
  });
  for (const encounterId of ["enc-multiple-principal", "enc-malformed-principal"]) {
    const result = await handleVisitChargeMutationRequest({ authenticate }, {
      authHeader: "Bearer clinician",
      params: { encounterId },
      body: { procedureConceptKey: "comprehensive-exam-established" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual((result.body as { proposal: ChargeProposal }).proposal.dxPointers, []);
  }
});

test("visit replacement preserves diagnosis edits and remove-revive never touches other charges", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-lifecycle",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
  } satisfies Encounter);
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "clinician" as const,
    fhir,
  });
  const store = new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
  await store.save(chargeProposal({ id: "protocol-charge", encounterId: "enc-lifecycle" }));

  await handleVisitChargeMutationRequest({ authenticate, now: () => NOW }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-lifecycle" },
    body: { procedureConceptKey: "comprehensive-exam-new" },
  });
  const created = await store.get("manual-visit-code:enc-lifecycle");
  assert.deepEqual(created?.dxPointers, []);
  await store.save({ ...created!, dxPointers: ["Condition/edited"] });

  await handleVisitChargeMutationRequest({ authenticate, now: () => "2026-08-11T16:00:00.000Z" }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-lifecycle" },
    body: { procedureConceptKey: "intermediate-exam-established" },
  });
  const changed = await store.get("manual-visit-code:enc-lifecycle");
  assert.equal(changed?.procedureConceptKey, "intermediate-exam-established");
  assert.deepEqual(changed?.dxPointers, ["Condition/edited"]);

  await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-lifecycle" },
    body: { procedureConceptKey: null },
  });
  assert.equal((await store.get("manual-visit-code:enc-lifecycle"))?.state, "removed");
  await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-lifecycle" },
    body: { procedureConceptKey: "intermediate-exam-established" },
  });
  assert.equal((await store.get("manual-visit-code:enc-lifecycle"))?.state, "accepted");
  assert.deepEqual(await store.get("protocol-charge"), chargeProposal({
    id: "protocol-charge",
    encounterId: "enc-lifecycle",
  }));
});

test("visit charge conflicts and inactive concepts fail closed", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-conflict",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
  } satisfies Encounter);
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "clinician" as const,
    fhir,
  });
  assert.equal((await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-conflict" },
    body: { procedureConceptKey: "refraction" },
  })).status, 400);

  await saveProcedureFeeScheduleItem(fhir, {
    procedureConceptKey: "office-visit-new-low",
    active: false,
  });
  assert.equal((await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-conflict" },
    body: { procedureConceptKey: "office-visit-new-low" },
  })).status, 400);

  const store = new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
  await store.save(manualChargeProposal({
    id: "manual-visit-code:enc-conflict",
    encounterId: "enc-conflict",
    state: "finalized",
    chargeItemRef: "ChargeItem/final",
    procedureConceptKey: "comprehensive-exam-new",
  }));
  assert.equal((await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-conflict" },
    body: { procedureConceptKey: "intermediate-exam-new" },
  })).status, 409);
  assert.equal((await store.get("manual-visit-code:enc-conflict"))?.procedureConceptKey, "comprehensive-exam-new");

  await store.save(manualChargeProposal({
    id: "second-manual-visit",
    encounterId: "enc-conflict",
    planActionRef: "manual-visit-code",
    procedureConceptKey: "office-visit-established-low",
  }));
  assert.equal((await handleVisitChargeRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-conflict" },
  })).status, 409);
});

test("a protocol-linked visit concept conflicts instead of allowing a second visit row", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-protocol-visit",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
  } satisfies Encounter);
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "clinician" as const,
    fhir,
  });
  const store = new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
  await store.save(chargeProposal({
    id: "protocol-owned-visit",
    encounterId: "enc-protocol-visit",
    procedureConceptKey: "comprehensive-exam-new",
  }));

  const result = await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-protocol-visit" },
    body: { procedureConceptKey: "intermediate-exam-new" },
  });
  assert.equal(result.status, 409);
  assert.equal(await store.get("manual-visit-code:enc-protocol-visit"), undefined);
  assert.equal((await store.get("protocol-owned-visit"))?.procedureConceptKey, "comprehensive-exam-new");
});
