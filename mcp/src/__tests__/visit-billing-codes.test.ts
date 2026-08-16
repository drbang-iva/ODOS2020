import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItem, ChargeItemDefinition, Condition, Encounter, Resource } from "@medplum/fhirtypes";
import {
  HCPCS_CODE_SYSTEM,
  PROCEDURE_FEE_SEEDS,
  PROCEDURE_CONCEPT_SYSTEM,
  buildProcedureFeeDefinition,
  createProcedureFeeScheduleItem,
  listActiveCodedNonVisitProcedureFees,
  listProcedureFeeSchedule,
  materializeAcceptedChargeProposals,
  saveProcedureFeeScheduleItem,
} from "../clinical-graph/procedure-fee-schedule.js";
import type { ChargeProposal, ProtocolApplication } from "../clinical-graph/protocol-types.js";
import {
  handleProtocolSignCleanupRequest,
  handleVisitChargeMutationRequest,
  handleVisitChargeRequest,
} from "../clinical-graph/protocol-endpoint.js";
import { PROTOCOL_BASIC_CODES, ProtocolBasicStore } from "../clinical-graph/protocol-store.js";
import { buildProfessionalClaim } from "../claims/claimmd-fhir.js";

class MemoryFhir {
  resources: Resource[] = [];
  next = 1;

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) {
      const error = new Error(`${resourceType}/${id} not found`);
      (error as Error & { status?: number }).status = 404;
      throw error;
    }
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

  async createWithOutcome<T extends Resource>(
    resource: T,
    headers?: Record<string, string>,
  ): Promise<{ resource: T; created: boolean }> {
    return { resource: await this.create(resource, headers), created: true };
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
  assert.deepEqual(
    PROCEDURE_FEE_SEEDS.map((row) => row.category),
    [
      ...Array(5).fill("procedure"),
      ...Array(12).fill("exam"),
      "refraction",
    ],
  );
});

test("the exported visit procedure family classifier owns every shipped family", async () => {
  const feeSchedule = await import("../clinical-graph/procedure-fee-schedule.js");
  const classifier = (feeSchedule as Record<string, unknown>).visitProcedureFamily;
  assert.equal(typeof classifier, "function");
  assert.deepEqual(
    VISIT_KEYS.map((key) => (classifier as (value: string) => string | undefined)(key)),
    [
      "eye-code",
      "eye-code",
      "eye-code",
      "eye-code",
      "em",
      "em",
      "em",
      "em",
      "em",
      "em",
      "vision-plan",
      "vision-plan",
    ],
  );
  assert.equal((classifier as (value: string) => string | undefined)("refraction"), undefined);
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

test("practice-created concepts persist their typed display and separate worksheet fields across reloads", async () => {
  const fhir = new MemoryFhir();
  await listProcedureFeeSchedule(fhir);
  const seededBefore = structuredClone(fhir.resources);

  const created = await createProcedureFeeScheduleItem(fhir, {
    display: "Custom dry eye imaging",
    category: "procedure",
    modifier: " synthmod ",
    active: true,
  });
  assert.equal(created.id, "custom-dry-eye-imaging");
  assert.equal(created.procedureConceptKey, "custom-dry-eye-imaging");
  assert.equal(created.display, "Custom dry eye imaging");
  assert.equal(created.active, true);
  assert.equal(created.category, "procedure");
  assert.equal(created.modifier, "SYNTHMOD");
  assert.equal(created.version, "1");

  const reloaded = (await listProcedureFeeSchedule(fhir)).find((item) =>
    item.procedureConceptKey === "custom-dry-eye-imaging"
  );
  assert.equal(reloaded?.display, "Custom dry eye imaging");
  assert.notEqual(String(reloaded?.display), "Custom Dry Eye Imaging");
  assert.equal(reloaded?.category, "procedure");
  assert.equal(reloaded?.modifier, "SYNTHMOD");
  assert.equal(reloaded?.billingCode, undefined);
  assert.deepEqual(await listActiveCodedNonVisitProcedureFees(fhir), []);

  const coded = await saveProcedureFeeScheduleItem(fhir, {
    procedureConceptKey: "custom-dry-eye-imaging",
    billingCode: " syntha ",
    active: true,
  });
  assert.equal(coded.billingCode, "SYNTHA");
  assert.equal(coded.modifier, "SYNTHMOD");
  assert.equal(coded.display, "Custom dry eye imaging");
  assert.deepEqual(
    (await listActiveCodedNonVisitProcedureFees(fhir)).map((item) => ({
      procedureConceptKey: item.procedureConceptKey,
      billingCode: item.billingCode,
      modifier: item.modifier,
    })),
    [{
      procedureConceptKey: "custom-dry-eye-imaging",
      billingCode: "SYNTHA",
      modifier: "SYNTHMOD",
    }],
  );
  assert.equal(coded.billingCode.includes("SYNTHMOD"), false);
  assert.deepEqual(fhir.resources.slice(0, seededBefore.length), seededBefore);
});

test("practice-created concept key collisions reject without writing or replacing seeded concepts", async () => {
  const fhir = new MemoryFhir();
  await listProcedureFeeSchedule(fhir);
  const beforeCreate = fhir.resources.length;
  await createProcedureFeeScheduleItem(fhir, {
    display: "Special imaging",
    category: "procedure",
    active: true,
  });
  const afterCreate = fhir.resources.length;
  assert.equal(afterCreate, beforeCreate + 1);

  await assert.rejects(() => createProcedureFeeScheduleItem(fhir, {
    display: "Special imaging",
    category: "exam",
    active: true,
  }), /already exists/);
  assert.equal(fhir.resources.length, afterCreate);

  await assert.rejects(() => createProcedureFeeScheduleItem(fhir, {
    display: "Refraction",
    category: "procedure",
    active: true,
  }), /already exists/);
  assert.equal(fhir.resources.length, afterCreate);
  assert.equal((await listProcedureFeeSchedule(fhir)).filter((item) =>
    item.procedureConceptKey === "refraction"
  ).length, 1);
});

test("a conditional-create race reports a conflict instead of reusing the competing concept", async () => {
  class RacingFhir extends MemoryFhir {
    override async createWithOutcome<T extends Resource>(): Promise<{ resource: T; created: boolean }> {
      return {
        resource: {
          ...buildProcedureFeeDefinition({
            procedureConceptKey: "racing-procedure",
            display: "Competing display",
            category: "exam",
            billingCode: "SYNTHR",
          }),
          id: "competing-definition",
        } as T,
        created: false,
      };
    }
  }
  const fhir = new RacingFhir();
  await assert.rejects(() => createProcedureFeeScheduleItem(fhir, {
    display: "Racing procedure",
    category: "procedure",
    modifier: "SYNTHMOD",
    active: true,
  }), /already exists/);
  assert.equal(fhir.resources.length, 0);
});

test("six active concepts sharing one code remain six distinct chart procedure options", async () => {
  const fhir = new MemoryFhir();
  for (let index = 1; index <= 6; index += 1) {
    await createProcedureFeeScheduleItem(fhir, {
      display: `Synthetic fitting ${index}`,
      category: "cl-fitting",
      billingCode: "SYNTHA",
      priceCents: 10_000 + index,
      active: true,
    });
  }
  const options = await listActiveCodedNonVisitProcedureFees(fhir);
  assert.equal(options.length, 6);
  assert.deepEqual(options.map((option) => option.procedureConceptKey), [
    "synthetic-fitting-1",
    "synthetic-fitting-2",
    "synthetic-fitting-3",
    "synthetic-fitting-4",
    "synthetic-fitting-5",
    "synthetic-fitting-6",
  ]);
  assert.equal(options.every((option) => option.billingCode === "SYNTHA"), true);
  assert.equal(new Set(options.map((option) => option.priceCents)).size, 6);
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
  const conceptOnly = validFhir.resources.filter((row): row is ChargeItem => row.resourceType === "ChargeItem");
  assert.equal(conceptOnly.length, 1);
  assert.deepEqual(conceptOnly[0]?.code.coding, [{
    system: PROCEDURE_CONCEPT_SYSTEM,
    code: "gonioscopy",
    display: "Gonioscopy",
  }]);

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
  } satisfies Encounter, {
    resourceType: "Condition",
    id: "principal",
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: "Encounter/enc-visit" },
    clinicalStatus: { coding: [{ code: "active" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
    code: { text: "Principal diagnosis" },
  } satisfies Condition);
  const authenticate = async (header: string | undefined) => header === "Bearer clinician"
    ? { staffReference: "Practitioner/doc", actorRole: "provider" as const, fhir }
    : header === "Bearer front"
      ? { staffReference: "Practitioner/front", actorRole: "staff" as const, fhir }
      : header === "Bearer auditor"
        ? { staffReference: "Practitioner/auditor", actorRole: "admin" as const, fhir }
      : null;

  assert.equal((await handleVisitChargeRequest({ authenticate }, {
    authHeader: undefined,
    params: { encounterId: "enc-visit" },
  })).status, 401);
  assert.equal((await handleVisitChargeRequest({ authenticate }, {
    authHeader: "Bearer auditor",
    params: { encounterId: "enc-visit" },
  })).status, 200);
  assert.equal((await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer auditor",
    params: { encounterId: "enc-visit" },
    body: { procedureConceptKey: "routine-vision-exam-new" },
  })).status, 403);

  const initial = await handleVisitChargeMutationRequest({ authenticate, now: () => NOW }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-visit" },
    body: { procedureConceptKey: "routine-vision-exam-new" },
  });
  assert.equal(initial.status, 200);
  assert.equal((initial.body as { procedureFamily?: string }).procedureFamily, "vision-plan");
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
    procedureFamily?: string;
    diagnoses: Array<{ reference: string; display: string; rank?: number }>;
    options: Array<{ procedureConceptKey: string; billingCode?: string }>;
  };
  assert.equal(body.selectedProcedureConceptKey, "routine-vision-exam-new");
  assert.equal(body.procedureFamily, "vision-plan");
  assert.deepEqual(body.diagnoses, [{
    reference: "Condition/principal",
    display: "Principal diagnosis",
    rank: 1,
  }]);
  assert.equal(body.options.length, 12);
  assert.equal(body.options.some((option) => option.procedureConceptKey === "refraction"), false);
  assert.equal(body.options.find((option) => option.procedureConceptKey === "routine-vision-exam-new")?.billingCode, "S0620");
});

test("visit charge reads remain available when the encounter resource is absent", async () => {
  const fhir = new MemoryFhir();
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "provider" as const,
    fhir,
  });

  const result = await handleVisitChargeRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-missing" },
  });
  assert.equal(result.status, 200);
  const body = result.body as {
    diagnoses: unknown[];
    options: Array<{ procedureConceptKey: string }>;
    proposal?: ChargeProposal;
  };
  assert.deepEqual(body.diagnoses, []);
  assert.equal(body.options.length, 12);
  assert.equal(body.proposal, undefined);
});

test("visit charge reads do not hide a missing diagnosis referenced by an existing encounter", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-missing-diagnosis",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    diagnosis: [{ condition: { reference: "Condition/missing" }, rank: 1 }],
  } satisfies Encounter);
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "provider" as const,
    fhir,
  });

  await assert.rejects(
    handleVisitChargeRequest({ authenticate }, {
      authHeader: "Bearer clinician",
      params: { encounterId: "enc-missing-diagnosis" },
    }),
    /Condition\/missing not found/,
  );
});

test("an explicit create pointer wins while omission still derives the principal diagnosis", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-explicit-pointer",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    diagnosis: [
      { condition: { reference: "Condition/principal" }, rank: 1 },
      { condition: { reference: "Condition/secondary" }, rank: 2 },
    ],
  } satisfies Encounter, {
    resourceType: "Encounter",
    id: "enc-derived-pointer",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    diagnosis: [{ condition: { reference: "Condition/derived" }, rank: 1 }],
  } satisfies Encounter);
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "provider" as const,
    fhir,
  });

  const explicit = await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-explicit-pointer" },
    body: {
      procedureConceptKey: "office-visit-new-low",
      dxPointer: "Condition/secondary",
    },
  });
  assert.equal(explicit.status, 200);
  assert.deepEqual((explicit.body as { proposal: ChargeProposal }).proposal.dxPointers, ["Condition/secondary"]);

  const derived = await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-derived-pointer" },
    body: { procedureConceptKey: "office-visit-new-low" },
  });
  assert.equal(derived.status, 200);
  assert.deepEqual((derived.body as { proposal: ChargeProposal }).proposal.dxPointers, ["Condition/derived"]);
});

test("visit diagnosis pointer changes validate, clear, and round-trip without a fallback", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-pointer-edit",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    diagnosis: [
      { condition: { reference: "Condition/principal" }, rank: 1 },
      { condition: { reference: "Condition/secondary" }, rank: 2 },
    ],
  } satisfies Encounter, ...["principal", "secondary"].map((id) => ({
    resourceType: "Condition" as const,
    id,
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: "Encounter/enc-pointer-edit" },
    clinicalStatus: { coding: [{ code: "active" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
    code: { text: id === "principal" ? "Principal diagnosis" : "Secondary diagnosis" },
  })));
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "provider" as const,
    fhir,
  });

  assert.equal((await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-pointer-edit" },
    body: { procedureConceptKey: "office-visit-established-low" },
  })).status, 200);
  const foreign = await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-pointer-edit" },
    body: { dxPointer: "Condition/foreign" },
  });
  assert.equal(foreign.status, 400);
  assert.match((foreign.body as { error: string }).error, /not present on this encounter/i);

  const changed = await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-pointer-edit" },
    body: { dxPointer: "Condition/secondary" },
  });
  assert.equal(changed.status, 200);
  assert.deepEqual((changed.body as { proposal: ChargeProposal }).proposal.dxPointers, ["Condition/secondary"]);

  const cleared = await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-pointer-edit" },
    body: { dxPointer: null },
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual((cleared.body as { proposal: ChargeProposal }).proposal.dxPointers, []);

  const read = await handleVisitChargeRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-pointer-edit" },
  });
  assert.deepEqual((read.body as { proposal: ChargeProposal }).proposal.dxPointers, []);
});

test("a pointer-only edit without an existing visit proposal returns 404 without saving a malformed charge", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-missing-proposal",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    diagnosis: [{ condition: { reference: "Condition/principal" }, rank: 1 }],
  } satisfies Encounter);
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "provider" as const,
    fhir,
  });

  const result = await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-missing-proposal" },
    body: { dxPointer: "Condition/principal" },
  });
  assert.equal(result.status, 404);
  assert.match((result.body as { error: string }).error, /proposal not found/i);
  const store = new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
  assert.equal(await store.get("manual-visit-code:enc-missing-proposal"), undefined);
});

test("diagnosis reorder and principal changes never move an operator-selected visit pointer", async () => {
  const fhir = new MemoryFhir();
  const encounter: Encounter = {
    resourceType: "Encounter",
    id: "enc-stable-pointer",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    diagnosis: [
      { condition: { reference: "Condition/principal" }, rank: 1 },
      { condition: { reference: "Condition/selected" }, rank: 2 },
    ],
  };
  fhir.resources.push(encounter);
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "provider" as const,
    fhir,
  });
  const store = new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal);

  const created = await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-stable-pointer" },
    body: {
      procedureConceptKey: "office-visit-new-moderate",
      dxPointer: "Condition/selected",
    },
  });
  assert.equal(created.status, 200);
  await fhir.update("Encounter", "enc-stable-pointer", {
    ...encounter,
    diagnosis: [
      { condition: { reference: "Condition/new-principal" }, rank: 1 },
      { condition: { reference: "Condition/principal" }, rank: 2 },
      { condition: { reference: "Condition/selected" }, rank: 3 },
    ],
  });

  assert.equal((await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-stable-pointer" },
    body: { procedureConceptKey: "office-visit-established-moderate" },
  })).status, 200);
  assert.deepEqual((await store.get("manual-visit-code:enc-stable-pointer"))?.dxPointers, ["Condition/selected"]);
});

test("a finalized visit charge rejects diagnosis pointer changes", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-finalized-pointer",
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    diagnosis: [{ condition: { reference: "Condition/principal" }, rank: 1 }],
  } satisfies Encounter);
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "provider" as const,
    fhir,
  });
  const store = new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
  await store.save(manualChargeProposal({
    id: "manual-visit-code:enc-finalized-pointer",
    encounterId: "enc-finalized-pointer",
    planActionRef: "manual-visit-code",
    procedureConceptKey: "office-visit-new-low",
    dxPointers: ["Condition/principal"],
    state: "finalized",
    chargeItemRef: "ChargeItem/finalized-visit",
  }));

  const result = await handleVisitChargeMutationRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-finalized-pointer" },
    body: { dxPointer: null },
  });
  assert.equal(result.status, 409);
  assert.deepEqual((await store.get("manual-visit-code:enc-finalized-pointer"))?.dxPointers, ["Condition/principal"]);
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
    actorRole: "provider" as const,
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
    actorRole: "provider" as const,
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
    actorRole: "provider" as const,
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
    actorRole: "provider" as const,
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

test("selecting then signing materializes the billing-first visit charge with its diagnosis pointer", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-e2e",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-e2e" },
    period: { start: "2026-08-11T14:00:00.000Z" },
    diagnosis: [{ condition: { reference: "Condition/principal-e2e" }, rank: 1 }],
  } satisfies Encounter);
  const authenticate = async () => ({
    staffReference: "Practitioner/doc",
    actorRole: "provider" as const,
    fhir,
  });
  const selected = await handleVisitChargeMutationRequest({ authenticate, now: () => NOW }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-e2e" },
    body: { procedureConceptKey: "routine-vision-exam-new" },
  });
  assert.equal(selected.status, 200);
  const accepted = (selected.body as { proposal: ChargeProposal }).proposal;
  assert.equal(accepted.state, "accepted");
  assert.equal(Object.hasOwn(accepted, "protocolApplicationId"), false);
  assert.deepEqual(accepted.dxPointers, ["Condition/principal-e2e"]);

  const signed = await handleProtocolSignCleanupRequest({
    authenticate,
    feeScheduleFhir: fhir,
    now: () => NOW,
  }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-e2e" },
  });
  assert.deepEqual(signed, {
    status: 200,
    body: { abandoned: 0, materialized: 1, finalized: 1 },
  });
  const chargeItem = fhir.resources.find((row): row is ChargeItem => row.resourceType === "ChargeItem");
  assert.ok(chargeItem?.id);
  assert.deepEqual(chargeItem.code.coding, [
    {
      system: HCPCS_CODE_SYSTEM,
      code: "S0620",
      display: "Routine vision exam — new patient",
    },
    {
      system: PROCEDURE_CONCEPT_SYSTEM,
      code: "routine-vision-exam-new",
      display: "Routine vision exam — new patient",
    },
  ]);
  assert.deepEqual(chargeItem.supportingInformation, [{ reference: "Condition/principal-e2e" }]);
  const store = new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
  assert.deepEqual(await store.get("manual-visit-code:enc-e2e"), {
    ...accepted,
    state: "finalized",
    chargeItemRef: `ChargeItem/${chargeItem.id}`,
  });

  const claim = buildProfessionalClaim({
    created: "2026-08-11",
    serviceDate: "2026-08-11",
    patientReference: "Patient/patient-e2e",
    providerReference: "Practitioner/doc",
    insurerReference: "Organization/payer",
    coverageReference: "Coverage/coverage",
    patientAccountNumber: "SYNTHETIC-E2E",
    payerId: "SYNTHETIC",
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
    diagnoses: [{ system: "https://example.test/diagnosis", code: "DX-E2E" }],
    chargeItems: [{ ...chargeItem, diagnosisSequence: [1] }],
  });
  assert.deepEqual(claim.item?.[0]?.productOrService.coding?.[0], {
    system: HCPCS_CODE_SYSTEM,
    code: "S0620",
    display: "Routine vision exam — new patient",
  });
  assert.notEqual(claim.item?.[0]?.productOrService.coding?.[0]?.code, "routine-vision-exam-new");

  if (process.env.ODOS_SHOW_VISIT_CHARGE === "1") {
    console.log(`VISIT_CHARGE_ITEM=${JSON.stringify(chargeItem, null, 2)}`);
  }
});
