import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Bundle,
  ChargeItem,
  ChargeItemDefinition,
  Encounter,
  Resource,
} from "@medplum/fhirtypes";
import { loadDayClose } from "../src/desk/day-close.js";
import { GLAUCOMA_SUSPECT_PROTOCOL } from "../src/clinical-graph/protocol-fixtures.js";
import { handleProtocolSignCleanupRequest } from "../src/clinical-graph/protocol-endpoint.js";
import {
  handleProcedureFeeScheduleCreateRequest,
  handleProcedureFeeScheduleMutationRequest,
  handleProcedureFeeScheduleRequest,
} from "../src/clinical-graph/procedure-fee-schedule-endpoint.js";
import {
  ODOS_UNPRICED_CHARGE_EXTENSION_URL,
  PROCEDURE_FEE_SEEDS,
  materializeAcceptedChargeProposals,
  saveProcedureFeeScheduleItem,
} from "../src/clinical-graph/procedure-fee-schedule.js";
import { ProtocolService } from "../src/clinical-graph/protocol-service.js";
import type { ChargeProposal, ProtocolApplication } from "../src/clinical-graph/protocol-types.js";
import { handleOpenChargesRequest } from "../src/payments/payment-collection-handler.js";
import type { FhirSearchParams } from "../src/fhir-client.js";

const NOW = "2026-07-21T15:30:00.000Z";

class MemoryFhir {
  resources: Resource[] = [];
  createHeaders: Array<{ resourceType: string; headers?: Record<string, string> }> = [];
  updateHeaders: Array<{ resourceType: string; headers?: Record<string, string> }> = [];
  next = 1;

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) throw new Error(`${resourceType}/${id} not found`);
    return structuredClone(resource) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: FhirSearchParams = {},
  ): Promise<Bundle<T>> {
    const query = new URLSearchParams(params);
    let rows = this.resources.filter((row) => row.resourceType === resourceType);
    const code = query.get("code")?.split("|");
    if (code?.[1]) rows = rows.filter((row) => "code" in row && row.code?.coding?.some((coding) =>
      coding.system === code[0] && coding.code === code[1]
    ));
    const identifier = query.get("identifier")?.split("|");
    if (identifier?.[1]) rows = rows.filter((row) => "identifier" in row && row.identifier?.some((value) =>
      value.system === identifier[0] && value.value === identifier[1]
    ));
    const subject = query.get("subject");
    if (subject) rows = rows.filter((row) => "subject" in row && row.subject?.reference === subject);
    const status = query.get("status");
    if (status) rows = rows.filter((row) => "status" in row && row.status === status);
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
    this.createHeaders.push({ resourceType: resource.resourceType, headers });
    const conditional = headers?.["If-None-Exist"]?.replace(/^identifier=/, "").split("|");
    if (conditional?.[1] && "identifier" in resource) {
      const existing = this.resources.find((row) => "identifier" in row && row.identifier?.some((value) =>
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
    headers?: Record<string, string>,
  ): Promise<T> {
    this.updateHeaders.push({ resourceType, headers });
    const saved = { ...structuredClone(resource), id } as T;
    const index = this.resources.findIndex((row) => row.resourceType === resourceType && row.id === id);
    if (index < 0) throw new Error(`${resourceType}/${id} not found for update`);
    this.resources[index] = saved;
    return structuredClone(saved);
  }
}

test("sign cleanup materializes five accepted proposals once and existing money surfaces consume them", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-1",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    period: { start: "2026-07-21T13:00:00.000Z" },
  } satisfies Encounter);
  let nextId = 1;
  const service = new ProtocolService(fhir, {
    async commitFinding(finding) {
      return finding.value === undefined ? undefined : `Observation/${finding.id}`;
    },
    async materializeAction(action) {
      return `${action.actionType === "order" ? "ServiceRequest" : "CarePlan"}/${action.id}`;
    },
  }, () => NOW, () => `protocol-${nextId++}`);
  await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL);
  const opened = await service.open(GLAUCOMA_SUSPECT_PROTOCOL.id, {
    encounterId: "enc-1",
    patientId: "patient-1",
    diagnosis: { reference: "Condition/dx-1", code: "H40.021", confirmed: true },
    actor: "Practitioner/clinician-1",
  });
  await service.commit(opened.application.id, [], ["Condition/dx-1"]);
  const staged = await service.charges.list();
  assert.equal(staged.length, 5);
  for (const proposal of staged) await service.charges.save({ ...proposal, state: "accepted" });
  await service.charges.save({
    ...staged[0]!,
    id: "removed-proposal",
    planActionRef: "removed-charge",
    state: "removed",
  });
  await service.charges.save({
    ...staged[1]!,
    id: "overridden-proposal",
    planActionRef: "overridden-charge",
    state: "overridden",
  });

  await saveProcedureFeeScheduleItem(fhir, {
    procedureConceptKey: "gonioscopy",
    priceCents: 12_345,
    active: true,
  });
  const deps = {
    authenticate: async () => ({
      staffReference: "Practitioner/clinician-1",
      actorRole: "clinician" as const,
      fhir,
    }),
    feeScheduleFhir: fhir,
    now: () => NOW,
  };
  const first = await handleProtocolSignCleanupRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
  });
  assert.deepEqual(first, {
    status: 200,
    body: { abandoned: 0, materialized: 5, finalized: 5 },
  });
  const chargeItems = fhir.resources.filter((row): row is ChargeItem => row.resourceType === "ChargeItem");
  assert.equal(chargeItems.length, 5);
  assert.equal(chargeItems.every((charge) =>
    charge.status === "billable" &&
    charge.context?.reference === "Encounter/enc-1" &&
    charge.subject.reference === "Patient/patient-1" &&
    charge.supportingInformation?.[0]?.reference === "Condition/dx-1"
  ), true);
  const gonioscopy = chargeItems.find((charge) => charge.code.coding?.[0]?.code === "gonioscopy");
  assert.deepEqual(gonioscopy?.priceOverride, { value: 123.45, currency: "USD" });
  assert.equal(gonioscopy?.extension, undefined);
  const unpriced = chargeItems.filter((charge) => charge.code.coding?.[0]?.code !== "gonioscopy");
  assert.equal(unpriced.length, 4);
  assert.equal(unpriced.every((charge) =>
    charge.priceOverride?.value === 0 &&
    charge.extension?.some((extension) =>
      extension.url === ODOS_UNPRICED_CHARGE_EXTENSION_URL && extension.valueBoolean === true
    )
  ), true);
  assert.equal(fhir.createHeaders.filter((entry) =>
    entry.resourceType === "ChargeItem" && entry.headers?.["If-None-Exist"]?.includes("charge-proposal-charge-item")
  ).length, 5);
  const proposals = await service.charges.list();
  assert.equal(proposals.filter((proposal) => proposal.state === "finalized" && proposal.chargeItemRef).length, 5);
  assert.equal(proposals.find((proposal) => proposal.id === "removed-proposal")?.chargeItemRef, undefined);
  assert.equal(proposals.find((proposal) => proposal.id === "overridden-proposal")?.chargeItemRef, undefined);

  const second = await handleProtocolSignCleanupRequest(deps, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-1" },
  });
  assert.deepEqual(second, {
    status: 200,
    body: { abandoned: 0, materialized: 0, finalized: 0 },
  });
  assert.equal(fhir.resources.filter((row) => row.resourceType === "ChargeItem").length, 5);

  const openCharges = await handleOpenChargesRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/front-1",
      actorRole: "front-desk",
      roles: ["front-desk"],
      fhir,
    }),
  }, {
    authHeader: "Bearer front",
    patientReference: "Patient/patient-1",
  });
  assert.equal(openCharges.status, 200);
  assert.equal((openCharges.body as unknown[]).length, 5);

  const close = await loadDayClose(fhir, { date: "2026-07-21", timeZone: "America/New_York" });
  assert.equal(close.review.available, true);
  if (close.review.available) assert.equal(close.review.unattachedCharges.length, 5);
});

test("fee schedule endpoint seeds empty definitions, saves integer cents, and deactivates instead of deleting", async () => {
  const fhir = new MemoryFhir();
  const authenticate = async (header: string | undefined) => header === "Bearer admin"
    ? { staffReference: "Practitioner/admin", actorRole: "practice-admin" as const, fhir }
    : header === "Bearer clinician"
      ? { staffReference: "Practitioner/doc", actorRole: "clinician" as const, fhir }
      : null;
  assert.equal((await handleProcedureFeeScheduleRequest({ authenticate }, { authHeader: undefined })).status, 401);
  assert.equal((await handleProcedureFeeScheduleRequest({ authenticate }, { authHeader: "Bearer clinician" })).status, 403);
  const seeded = await handleProcedureFeeScheduleRequest({ authenticate }, { authHeader: "Bearer admin" });
  assert.equal(seeded.status, 200);
  const items = (seeded.body as { items: Array<{ priceCents?: number }> }).items;
  assert.equal(items.length, PROCEDURE_FEE_SEEDS.length);
  assert.equal(items.every((item) => item.priceCents === undefined), true);
  assert.equal(fhir.resources.filter((row) => row.resourceType === "ChargeItemDefinition").length, 5);
  const cornealDefinition = fhir.resources.find((row): row is ChargeItemDefinition =>
    row.resourceType === "ChargeItemDefinition" && row.title === "Corneal pachymetry"
  );
  assert.ok(cornealDefinition);
  cornealDefinition.meta = { ...cornealDefinition.meta, versionId: "7" };

  const saved = await handleProcedureFeeScheduleMutationRequest({ authenticate }, {
    authHeader: "Bearer admin",
    params: { procedureConceptKey: "corneal-pachymetry" },
    body: { action: "save", priceCents: 8_750, active: true },
  });
  assert.equal(saved.status, 200);
  assert.equal((saved.body as { item: { priceCents?: number; version: string } }).item.priceCents, 8_750);
  assert.equal((saved.body as { item: { priceCents?: number; version: string } }).item.version, "2");
  assert.deepEqual(fhir.updateHeaders.at(-1)?.headers, {
    "X-ODOS-Source": "procedure-fee-schedule",
    "If-Match": 'W/"7"',
  });

  const deactivated = await handleProcedureFeeScheduleMutationRequest({ authenticate }, {
    authHeader: "Bearer admin",
    params: { procedureConceptKey: "corneal-pachymetry" },
    body: { action: "deactivate" },
  });
  assert.equal(deactivated.status, 200);
  assert.equal((deactivated.body as { item: { active: boolean; priceCents?: number } }).item.active, false);
  assert.equal((deactivated.body as { item: { active: boolean; priceCents?: number } }).item.priceCents, 8_750);
  const definitions = fhir.resources.filter((row): row is ChargeItemDefinition => row.resourceType === "ChargeItemDefinition");
  assert.equal(definitions.length, 5);
  assert.equal(definitions.find((definition) => definition.title === "Corneal pachymetry")?.status, "retired");
});

test("fee schedule creation endpoint is admin-only and reports key conflicts without a write", async () => {
  const fhir = new MemoryFhir();
  const authenticate = async (header: string | undefined) => header === "Bearer admin"
    ? { staffReference: "Practitioner/admin", actorRole: "practice-admin" as const, fhir }
    : header === "Bearer clinician"
      ? { staffReference: "Practitioner/doc", actorRole: "clinician" as const, fhir }
      : null;
  const body = {
    action: "create",
    display: "Custom tear imaging",
    category: "procedure",
    modifier: "SYNTHMOD",
    priceCents: null,
    active: true,
  };

  assert.equal((await handleProcedureFeeScheduleCreateRequest({ authenticate }, {
    authHeader: undefined,
    body,
  })).status, 401);
  assert.equal((await handleProcedureFeeScheduleCreateRequest({ authenticate }, {
    authHeader: "Bearer clinician",
    body,
  })).status, 403);

  const created = await handleProcedureFeeScheduleCreateRequest({ authenticate }, {
    authHeader: "Bearer admin",
    body,
  });
  assert.equal(created.status, 201);
  assert.equal((created.body as { item: { procedureConceptKey: string; display: string } }).item.procedureConceptKey,
    "custom-tear-imaging");
  assert.equal((created.body as { item: { display: string } }).item.display, "Custom tear imaging");
  const writesAfterCreate = fhir.resources.length;

  const conflict = await handleProcedureFeeScheduleCreateRequest({ authenticate }, {
    authHeader: "Bearer admin",
    body,
  });
  assert.equal(conflict.status, 409);
  assert.match((conflict.body as { error: string }).error, /already exists/);
  assert.equal(fhir.resources.length, writesAfterCreate);
});

test("accepted proposals with an invalid patient link fail before any ChargeItem write", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-corrupt",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-a" },
  } satisfies Encounter);
  const proposal: ChargeProposal = {
    id: "proposal-corrupt",
    encounterId: "enc-corrupt",
    protocolApplicationId: "application-corrupt",
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
      protocolId: "glaucoma-suspect-initial",
      protocolVersion: 1,
    },
  };
  await assert.rejects(() => materializeAcceptedChargeProposals({
      fhir,
      feeScheduleFhir: fhir,
      encounterId: "enc-corrupt",
      actorReference: "Practitioner/doc",
      charges: { list: async () => [proposal], save: async (row) => row },
      applications: {
        list: async () => [{
          id: "application-corrupt",
          encounterId: "enc-corrupt",
          patientId: "patient-b",
          protocolId: "glaucoma-suspect-initial",
          protocolVersion: 1,
          appliedBy: "Practitioner/doc",
          appliedAt: NOW,
          stackedWith: [],
          dispositions: [],
          dedupResolutions: [],
          undoState: "active",
          confirmed: true,
        }],
        save: async (row) => row,
      },
      now: () => NOW,
    }), /not linked to an active confirmed application/);
  assert.equal(fhir.resources.some((row) => row.resourceType === "ChargeItem"), false);
});

test("sign cleanup abandons unrelated open applications before a corrupt accepted proposal fails", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-cleanup-first",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-cleanup" },
  } satisfies Encounter);
  const service = new ProtocolService(fhir, {
    async commitFinding() { return undefined; },
    async materializeAction() { return undefined; },
  }, () => NOW);
  const openApplication: ProtocolApplication = {
    id: "application-open",
    encounterId: "enc-cleanup-first",
    patientId: "patient-cleanup",
    protocolId: "glaucoma-suspect-initial",
    protocolVersion: 1,
    appliedBy: "Practitioner/doc",
    appliedAt: NOW,
    stackedWith: [],
    dispositions: [],
    dedupResolutions: [],
    undoState: "active",
    confirmed: false,
  };
  const corruptApplication: ProtocolApplication = {
    ...openApplication,
    id: "application-corrupt-confirmed",
    patientId: "different-patient",
    confirmed: true,
  };
  await service.applications.save(openApplication);
  await service.applications.save(corruptApplication);
  await service.charges.save({
    id: "proposal-corrupt-cleanup",
    encounterId: "enc-cleanup-first",
    protocolApplicationId: corruptApplication.id,
    planActionRef: "charge-gonioscopy",
    procedureConceptKey: "gonioscopy",
    units: 1,
    laterality: "OU",
    dxPointers: ["Condition/dx-cleanup"],
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "protocol-default",
      actor: "Practitioner/doc",
      at: NOW,
      protocolId: "glaucoma-suspect-initial",
      protocolVersion: 1,
    },
  });

  await assert.rejects(() => handleProtocolSignCleanupRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/doc",
      actorRole: "clinician" as const,
      fhir,
    }),
    feeScheduleFhir: fhir,
    now: () => NOW,
  }, {
    authHeader: "Bearer clinician",
    params: { encounterId: "enc-cleanup-first" },
  }), /not linked to an active confirmed application/);

  assert.equal((await service.applications.get(openApplication.id))?.undoState, "unapplied");
  assert.equal(fhir.resources.some((row) => row.resourceType === "ChargeItem"), false);
});

test("a retry after ChargeItem creation but before proposal finalization reuses the conditional charge identity", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "enc-retry",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-retry" },
  } satisfies Encounter);
  let proposal: ChargeProposal = {
    id: "proposal-retry",
    encounterId: "enc-retry",
    protocolApplicationId: "application-retry",
    planActionRef: "charge-gonioscopy",
    procedureConceptKey: "gonioscopy",
    units: 1,
    laterality: "OU",
    dxPointers: ["Condition/dx-retry"],
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "protocol-default",
      actor: "Practitioner/doc",
      at: NOW,
      protocolId: "glaucoma-suspect-initial",
      protocolVersion: 1,
    },
  };
  const application: ProtocolApplication = {
    id: "application-retry",
    encounterId: "enc-retry",
    patientId: "patient-retry",
    protocolId: "glaucoma-suspect-initial",
    protocolVersion: 1,
    appliedBy: "Practitioner/doc",
    appliedAt: NOW,
    stackedWith: [],
    dispositions: [],
    dedupResolutions: [],
    undoState: "active",
    confirmed: true,
  };
  let failFinalization = true;
  const charges = {
    list: async () => [proposal],
    save: async (row: ChargeProposal) => {
      if (failFinalization) {
        failFinalization = false;
        throw new Error("simulated proposal update failure");
      }
      proposal = row;
      return row;
    },
  };
  const request = {
    fhir,
    feeScheduleFhir: fhir,
    encounterId: "enc-retry",
    actorReference: "Practitioner/doc",
    charges,
    applications: { list: async () => [application], save: async (row: ProtocolApplication) => row },
    now: () => NOW,
  };
  await assert.rejects(() => materializeAcceptedChargeProposals(request), /simulated proposal update failure/);
  assert.equal(fhir.resources.filter((row) => row.resourceType === "ChargeItem").length, 1);
  await materializeAcceptedChargeProposals(request);
  assert.equal(fhir.resources.filter((row) => row.resourceType === "ChargeItem").length, 1);
  assert.equal(proposal.state, "finalized");
  assert.match(proposal.chargeItemRef ?? "", /^ChargeItem\//);
});
