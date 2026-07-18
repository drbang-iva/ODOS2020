import assert from "node:assert/strict";
import test from "node:test";
import type { Basic, Bundle, CarePlan, Condition, Observation, ServiceRequest } from "@medplum/fhirtypes";
import { GLAUCOMA_SUSPECT_CHARGE_RULES, GLAUCOMA_SUSPECT_PROTOCOL } from "../clinical-graph/protocol-fixtures.js";
import {
  handleProtocolApplicationsRequest,
  handleProtocolApplyRequest,
  handleProtocolOffersRequest,
  protocolFindingObservation,
} from "../clinical-graph/protocol-endpoint.js";
import { buildProtocolBasic, PROTOCOL_BASIC_CODES, ProtocolBasicStore, type ProtocolFhirClient } from "../clinical-graph/protocol-store.js";
import { committedFindingEvidence, ProtocolService } from "../clinical-graph/protocol-service.js";
import type { PlanActionInstance, ProcedureChargeRule, ProtocolDefinition } from "../clinical-graph/protocol-types.js";

test("protocol-phase5.test.ts is included in full MCP discovery", () => {
  assert.ok(true);
});

class MemoryFhir implements ProtocolFhirClient {
  rows: Basic[] = [];
  headers: Array<Record<string, string> | undefined> = [];
  next = 1;
  paginateAt?: number;
  nextRows: Basic[] = [];
  searchParams: Array<Record<string, string> | undefined> = [];

  async search<T extends Basic>(_type: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>> {
    this.searchParams.push(params);
    const code = params?.code?.split("|")[1];
    const [identifierSystem, identifierValue] = params?.identifier?.split("|") ?? [];
    let rows = code ? this.rows.filter((row) => row.code?.coding?.some((coding) => coding.code === code)) : this.rows;
    if (identifierSystem && identifierValue) rows = rows.filter((row) => row.identifier?.some((identifier) =>
      identifier.system === identifierSystem && identifier.value === identifierValue));
    const page = this.paginateAt ? rows.slice(0, this.paginateAt) : rows;
    this.nextRows = this.paginateAt ? rows.slice(this.paginateAt) : [];
    return {
      resourceType: "Bundle", type: "searchset", entry: page.map((resource) => ({ resource: resource as T })),
      ...(this.nextRows.length ? { link: [{ relation: "next", url: "memory://protocol-next" }] } : {}),
    };
  }
  async searchUrl<T extends Basic>(): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: this.nextRows.map((resource) => ({ resource: resource as T })) };
  }
  async create<T extends Basic>(resource: T, headers?: Record<string, string>): Promise<T> {
    const conditional = headers?.["If-None-Exist"]?.replace(/^identifier=/, "");
    if (conditional) {
      const [system, value] = conditional.split("|");
      const existing = this.rows.find((row) => row.identifier?.some((identifier) =>
        identifier.system === system && identifier.value === value));
      if (existing) return existing as T;
    }
    const saved = { ...resource, id: `basic-${this.next++}` };
    this.rows.push(saved);
    this.headers.push(headers);
    return saved;
  }
  async update<T extends Basic>(_type: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
    const saved = { ...resource, id };
    this.rows[this.rows.findIndex((row) => row.id === id)] = saved;
    this.headers.push(headers);
    return saved;
  }
  async delete(_type: "Basic", id: string): Promise<void> {
    this.rows = this.rows.filter((row) => row.id !== id);
  }
}

function harness() {
  const fhir = new MemoryFhir();
  const projectedFindings: string[] = [];
  const materialized: string[] = [];
  const projectionControl: { failOnceOnActionType?: PlanActionInstance["actionType"]; failed: boolean } = {
    failed: false,
  };
  let id = 1;
  const service = new ProtocolService(fhir, {
    async commitFinding(finding) {
      projectedFindings.push(finding.id);
      return `Observation/${finding.id}`;
    },
    async materializeAction(action) {
      if (!projectionControl.failed && action.actionType === projectionControl.failOnceOnActionType) {
        projectionControl.failed = true;
        throw new Error(`Simulated ${action.actionType} projection failure.`);
      }
      materialized.push(action.id);
      return action.actionType === "order" ? `ServiceRequest/${action.id}` : `CarePlan/${action.id}`;
    },
  }, () => "2026-07-18T12:00:00.000Z", () => `id-${id++}`);
  return { fhir, service, projectedFindings, materialized, projectionControl };
}

test("fixture stores six Basic entity codes with X-ODOS-Source writes", async () => {
  const { fhir, service } = harness();
  await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL);
  const ruleStore = new ProtocolBasicStore<ProcedureChargeRule>(fhir, PROTOCOL_BASIC_CODES.procedureChargeRule);
  for (const rule of GLAUCOMA_SUSPECT_CHARGE_RULES) await ruleStore.save(rule);
  assert.equal((await ruleStore.list()).length, 5);
  assert.equal((await ruleStore.list()).every((rule) => rule.verificationStatus === "provisional"), true);
  assert.deepEqual(new Set((await ruleStore.list()).map((rule) => rule.procedureConceptKey)), new Set([
    "gonioscopy", "corneal-pachymetry", "scodi-optic-nerve", "visual-field-threshold", "fundus-photography",
  ]));
  const scodi = (await ruleStore.list()).find((rule) => rule.procedureConceptKey === "scodi-optic-nerve");
  assert.match(scodi?.sourceAuthority.citation ?? "", /A57804.*L34431/);
  assert.match(scodi?.sourceAuthority.additionalUrls?.[0] ?? "", /lcdId=34431/);
  assert.equal(fhir.headers.every((headers) => headers?.["X-ODOS-Source"] === "protocol-module"), true);
  assert.deepEqual(Object.values(PROTOCOL_BASIC_CODES).sort(), [
    "odos-charge-proposal", "odos-finding-instance", "odos-plan-action-instance",
    "odos-procedure-charge-rule", "odos-protocol-application", "odos-protocol-definition",
  ]);
});

test("ProtocolBasicStore follows next links and uses identifier-scoped conditional first writes", async () => {
  const fhir = new MemoryFhir();
  const store = new ProtocolBasicStore<ProtocolDefinition>(fhir, PROTOCOL_BASIC_CODES.protocolDefinition);
  const second = { ...GLAUCOMA_SUSPECT_PROTOCOL, id: "second-protocol", title: "Second" };
  await Promise.all([store.save(GLAUCOMA_SUSPECT_PROTOCOL), store.save(GLAUCOMA_SUSPECT_PROTOCOL)]);
  assert.equal(fhir.rows.length, 1);
  assert.match(fhir.headers[0]?.["If-None-Exist"] ?? "", /identifier=.*odos-protocol-definition\|glaucoma-suspect-initial$/);
  await store.save(second);
  fhir.paginateAt = 1;
  assert.deepEqual((await store.list()).map((row) => row.id).sort(), ["glaucoma-suspect-initial", "second-protocol"]);
  await store.get("second-protocol");
  assert.equal(fhir.searchParams.at(-1)?.identifier?.endsWith("|second-protocol"), true);
});

test("H40.02x offer is deliberate; open remains inert; commit creates the exact Phase 5 shape", async () => {
  const { service, projectedFindings, materialized } = harness();
  await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL);
  assert.equal((await service.offers([{ reference: "Condition/c1", code: "H40.021", confirmed: true }])).length, 1);
  assert.equal((await service.offers([{ reference: "Condition/c2", code: "H40.021", confirmed: false }])).length, 0);

  const opened = await service.open(GLAUCOMA_SUSPECT_PROTOCOL.id, {
    encounterId: "enc-1",
    patientId: "patient-1",
    diagnosis: { reference: "Condition/c1", code: "H40.021", confirmed: true },
    actor: "Practitioner/test",
  });
  assert.equal(opened.proposedFindings.length, 14);
  const proposedGonio = opened.proposedFindings.filter((row) => row.findingDefKey === "gonio_angle_structures");
  assert.equal(proposedGonio.length, 8);
  assert.deepEqual(new Set(proposedGonio.map((row) => row.laterality)), new Set(["OD", "OS"]));
  assert.deepEqual(new Set(proposedGonio.map((row) => row.componentKey)), new Set(["superior", "nasal", "inferior", "temporal"]));
  assert.equal(projectedFindings.length, 0);
  assert.equal(committedFindingEvidence(opened.proposedFindings).length, 0);

  await service.commit(opened.application.id, [], ["Condition/c1"]);
  assert.equal(projectedFindings.length, 10);
  const committedGonio = (await service.findings.list()).filter((row) =>
    row.findingDefKey === "gonio_angle_structures" && row.state === "committed"
  );
  assert.equal(committedGonio.length, 8);
  const promptOnly = (await service.findings.list()).filter((row) =>
    ["iop", "pachymetry-cct", "gonio_tm_pigmentation"].includes(row.findingDefKey)
  );
  assert.equal(promptOnly.length, 4);
  assert.equal(promptOnly.every((row) => row.observationReference === undefined), true);
  assert.equal(committedGonio.every((row) =>
    row.value === "ss" &&
    row.provenance.source === "protocol-default" &&
    row.provenance.entryMode === "propagated-uniform"
  ), true);
  const overridden = await service.editFinding(
    committedGonio.find((row) => row.laterality === "OD" && row.componentKey === "superior")!.id,
    "ptm",
    "Practitioner/clinician",
  );
  assert.equal(overridden.provenance.source, "clinician-entered");
  assert.equal(overridden.provenance.entryMode, "quadrant-specific");
  assert.equal((await service.findings.list()).filter((row) =>
    row.findingDefKey === "gonio_angle_structures" &&
    row.provenance.source === "protocol-default"
  ).length, 7);
  assert.equal(materialized.length, 8);
  assert.equal((await service.actions.list()).filter((row) => row.actionType === "order").length, 5);
  assert.equal((await service.charges.list()).length, 5);
  assert.equal((await service.charges.list()).every((row) =>
    row.coverageEvaluations.length === 1 &&
    row.coverageEvaluations[0]?.outcome === "no-rule" &&
    row.state === "staged"
  ), true);
  const application = await service.applications.get(opened.application.id);
  assert.equal(application?.protocolVersion, 1);
  assert.equal(application?.dispositions.length, GLAUCOMA_SUSPECT_PROTOCOL.items.length);
});

test("manual mergeKey collision resumes existing action and unapply preserves clinician changes", async () => {
  const { service } = harness();
  await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL);
  const opened = await service.open(GLAUCOMA_SUSPECT_PROTOCOL.id, {
    encounterId: "enc-1", patientId: "patient-1",
    diagnosis: { reference: "Condition/c1", code: "H40.021", confirmed: true },
    actor: "Practitioner/test",
  });
  await service.commit(opened.application.id, [], ["Condition/c1"]);
  const before = (await service.actions.list()).find((row) => row.mergeKey === "followup")!;
  const manual: Omit<PlanActionInstance, "id" | "protocolApplicationId" | "modifiedFields"> = {
    encounterId: "enc-1", patientId: "patient-1", actionType: "follow-up",
    linkedDx: ["Condition/c1"], linkedFindings: [], state: "selected", mergeKey: "followup",
    payload: { ...before.payload, interval: 3 },
    provenance: { source: "clinician-entered", actor: "Practitioner/test", at: "2026-07-18T12:05:00.000Z" },
  };
  const resumed = await service.addManualAction(manual);
  assert.equal(resumed.id, before.id);
  assert.equal(resumed.state, "modified");
  assert.deepEqual(resumed.modifiedFields, ["interval"]);
  assert.equal((await service.actions.list()).filter((row) => row.mergeKey === "followup").length, 1);
  const undo = await service.unapply(opened.application.id);
  assert.equal(undo.preserved.includes(before.id), true);
  assert.equal((await service.actions.get(before.id))?.state, "modified");
});

test("unapply removes only charges staged by its protocol application", async () => {
  const { service } = harness();
  await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL);
  const openedA = await service.open(GLAUCOMA_SUSPECT_PROTOCOL.id, {
    encounterId: "enc-a", patientId: "patient-a",
    diagnosis: { reference: "Condition/c-a", code: "H40.021", confirmed: true },
    actor: "Practitioner/test",
  });
  const openedB = await service.open(GLAUCOMA_SUSPECT_PROTOCOL.id, {
    encounterId: "enc-b", patientId: "patient-b",
    diagnosis: { reference: "Condition/c-b", code: "H40.022", confirmed: true },
    actor: "Practitioner/test",
  });
  await service.commit(openedA.application.id, [], ["Condition/c-a"]);
  await service.commit(openedB.application.id, [], ["Condition/c-b"]);

  const chargesBefore = await service.charges.list();
  assert.equal(chargesBefore.filter((row) => row.protocolApplicationId === openedA.application.id).length, 5);
  assert.equal(chargesBefore.filter((row) => row.protocolApplicationId === openedB.application.id).length, 5);

  await service.unapply(openedA.application.id);

  const chargesAfter = await service.charges.list();
  assert.equal(chargesAfter.filter((row) =>
    row.protocolApplicationId === openedA.application.id && row.state === "removed"
  ).length, 5);
  assert.equal(chargesAfter.filter((row) =>
    row.protocolApplicationId === openedB.application.id && row.state === "staged"
  ).length, 5);
  assert.equal(chargesAfter.filter((row) => row.protocolApplicationId === openedB.application.id).length, 5);
});

test("commit retry after a late partial failure skips all completed writes, then confirms once", async () => {
  const { service, projectedFindings, materialized, projectionControl } = harness();
  await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL);
  const opened = await service.open(GLAUCOMA_SUSPECT_PROTOCOL.id, {
    encounterId: "enc-retry",
    patientId: "patient-retry",
    diagnosis: { reference: "Condition/c-retry", code: "H40.021", confirmed: true },
    actor: "Practitioner/test",
  });
  let confirmedSaves = 0;
  const saveApplication = service.applications.save.bind(service.applications);
  service.applications.save = async (application) => {
    if (application.confirmed) confirmedSaves += 1;
    return saveApplication(application);
  };
  projectionControl.failOnceOnActionType = "follow-up";

  await assert.rejects(
    service.commit(opened.application.id, [], ["Condition/c-retry"]),
    /Simulated follow-up projection failure/,
  );
  assert.equal((await service.applications.get(opened.application.id))?.confirmed, false);
  assert.equal(projectedFindings.length, 10);
  assert.equal((await service.charges.list()).length, 5);
  assert.equal(materialized.length, 7);

  await service.commit(opened.application.id, [], ["Condition/c-retry"]);

  assert.equal(projectedFindings.length, 10);
  assert.equal((await service.findings.list()).filter((row) => row.state === "committed").length, 14);
  assert.equal((await service.charges.list()).length, 5);
  assert.equal(new Set((await service.charges.list()).map((row) =>
    `${row.protocolApplicationId}:${row.planActionRef}`
  )).size, 5);
  const actions = await service.actions.list();
  assert.equal(actions.length, 8);
  assert.equal(new Set(actions.map((row) =>
    `${row.protocolApplicationId}:${row.sourceItemKey}`
  )).size, 8);
  assert.equal(materialized.length, 8);
  assert.equal((await service.applications.get(opened.application.id))?.confirmed, true);
  assert.equal(confirmedSaves, 1);
});

test("deselected finding seeds are removed and never projected", async () => {
  const { service, projectedFindings } = harness();
  await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL);
  const opened = await service.open(GLAUCOMA_SUSPECT_PROTOCOL.id, {
    encounterId: "enc-optout", patientId: "patient-1",
    diagnosis: { reference: "Condition/c1", code: "H40.021", confirmed: true }, actor: "Practitioner/test",
  });
  await service.commit(opened.application.id, [{ itemKey: "gonio-angle", selected: false }], ["Condition/c1"]);
  const gonio = (await service.findings.list()).filter((row) => row.sourceItemKey === "gonio-angle");
  assert.equal(gonio.filter((row) => row.state === "proposed").length, 0);
  assert.equal(gonio.filter((row) => row.state === "removed").length, 8);
  assert.equal(projectedFindings.some((id) => gonio.some((row) => row.id === id)), false);
});

test("retry does not duplicate an already-saved action without a mergeKey", async () => {
  const { service, projectionControl } = harness();
  await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL);
  const opened = await service.open(GLAUCOMA_SUSPECT_PROTOCOL.id, {
    encounterId: "enc-no-merge-retry", patientId: "patient-1",
    diagnosis: { reference: "Condition/c1", code: "H40.021", confirmed: true }, actor: "Practitioner/test",
  });
  projectionControl.failOnceOnActionType = "follow-up";
  await assert.rejects(service.commit(opened.application.id, [], ["Condition/c1"]));
  await service.commit(opened.application.id, [], ["Condition/c1"]);
  const counseling = (await service.actions.list()).filter((row) => row.sourceItemKey === "counsel-suspect");
  assert.equal(counseling.length, 1);
  assert.equal(counseling[0]?.mergeKey, undefined);
});

test("offers performs no writes on the chart.read path", async () => {
  const fhir = new EndpointFhir();
  fhir.resources.push(buildProtocolBasic(GLAUCOMA_SUSPECT_PROTOCOL, PROTOCOL_BASIC_CODES.protocolDefinition));
  const result = await handleProtocolOffersRequest(endpointDeps(fhir), {
    authHeader: "Bearer test",
    body: { diagnoses: [{ reference: "Condition/c1", code: "H40.021", confirmed: true }] },
  });
  assert.equal(result.status, 200);
  assert.equal((result.body as { protocols: unknown[] }).protocols.length, 1);
  assert.equal(fhir.writes.length, 0);
});

test("apply verifies the persisted Condition and creates no prompt-only Observations", async () => {
  const condition = confirmedCondition();
  const invalidCases: Array<[string, Condition, string]> = [
    ["unconfirmed", { ...condition, verificationStatus: { coding: [{ code: "provisional" }] } }, "H40.021"],
    ["wrong code", condition, "H52.13"],
    ["wrong patient", { ...condition, subject: { reference: "Patient/other" } }, "H40.021"],
    ["wrong encounter", { ...condition, encounter: { reference: "Encounter/other" } }, "H40.021"],
    ["wrong trigger", { ...condition, code: { coding: [{ code: "H52.13" }] } }, "H52.13"],
  ];
  for (const [label, candidate, code] of invalidCases) {
    const fhir = new EndpointFhir();
    fhir.resources.push(buildProtocolBasic(GLAUCOMA_SUSPECT_PROTOCOL, PROTOCOL_BASIC_CODES.protocolDefinition), candidate);
    const result = await handleProtocolApplyRequest(endpointDeps(fhir), {
      authHeader: "Bearer test", body: applyBody(code),
    });
    assert.equal(result.status, 400, label);
  }
  const missing = new EndpointFhir();
  missing.resources.push(buildProtocolBasic(GLAUCOMA_SUSPECT_PROTOCOL, PROTOCOL_BASIC_CODES.protocolDefinition));
  assert.equal((await handleProtocolApplyRequest(endpointDeps(missing), {
    authHeader: "Bearer test", body: applyBody("H40.021"),
  })).status, 400);

  const fhir = new EndpointFhir();
  fhir.resources.push(buildProtocolBasic(GLAUCOMA_SUSPECT_PROTOCOL, PROTOCOL_BASIC_CODES.protocolDefinition), condition);
  const result = await handleProtocolApplyRequest(endpointDeps(fhir), {
    authHeader: "Bearer test", body: applyBody("H40.021"),
  });
  assert.equal(result.status, 200);
  const observations = fhir.resources.filter((resource): resource is Observation => resource.resourceType === "Observation");
  assert.equal(observations.length, 10);
  assert.equal(observations.some((observation) =>
    ["iop", "pachymetry-cct", "gonio_tm_pigmentation"].includes(observation.code.coding?.[0]?.code ?? "")
  ), false);
});

test("applications read enforces chart.read, returns the hydration shape, and duplicate apply is rejected", async () => {
  const fhir = new EndpointFhir();
  fhir.resources.push(
    buildProtocolBasic(GLAUCOMA_SUSPECT_PROTOCOL, PROTOCOL_BASIC_CODES.protocolDefinition),
    buildProtocolBasic({
      id: "app-1", encounterId: "enc-1", patientId: "patient-1", protocolId: GLAUCOMA_SUSPECT_PROTOCOL.id,
      protocolVersion: 1, appliedBy: "Practitioner/test", appliedAt: "2026-07-18T12:00:00.000Z",
      stackedWith: [], dispositions: [], dedupResolutions: [], undoState: "active" as const, confirmed: true,
    }, PROTOCOL_BASIC_CODES.protocolApplication),
    confirmedCondition(),
  );
  const read = await handleProtocolApplicationsRequest(endpointDeps(fhir), {
    authHeader: "Bearer test", query: { encounterId: "enc-1" },
  });
  assert.equal(read.status, 200);
  assert.deepEqual((read.body as { applications: unknown[] }).applications, [{
    id: "app-1", protocolId: GLAUCOMA_SUSPECT_PROTOCOL.id, version: 1, confirmed: true, undoState: "active",
  }]);
  const forbidden = await handleProtocolApplicationsRequest(endpointDeps(fhir, "auditor"), {
    authHeader: "Bearer test", query: { encounterId: "enc-1" },
  });
  assert.equal(forbidden.status, 403);
  const duplicate = await handleProtocolApplyRequest(endpointDeps(fhir), {
    authHeader: "Bearer test", body: applyBody("H40.021"),
  });
  assert.equal(duplicate.status, 409);
});

test("protocol numeric findings require the explicit cup-disc ratio unit mapping", () => {
  const base = {
    id: "finding-1", encounterId: "enc-1", patientId: "patient-1", protocolApplicationId: "app-1",
    sourceItemKey: "finding", laterality: "OD" as const, state: "committed" as const, value: 0.6,
    editedBeforeCommit: false, provenance: { source: "protocol-default" as const, actor: "Practitioner/test", at: "2026-07-18T12:00:00.000Z" },
  };
  const cupDisc = protocolFindingObservation({ ...base, findingDefKey: "cup_disc_ratio" });
  assert.deepEqual(cupDisc.valueQuantity, { value: 0.6, unit: "ratio", code: "1" });
  assert.throws(() => protocolFindingObservation({ ...base, findingDefKey: "iop" }), /explicit unit mapping/);
});

type EndpointResource = Basic | Observation | ServiceRequest | CarePlan | Condition;

class EndpointFhir {
  resources: EndpointResource[] = [];
  writes: EndpointResource[] = [];
  next = 1;

  async search<T extends Basic | Observation>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>> {
    let rows = this.resources.filter((resource) => resource.resourceType === resourceType);
    const code = params?.code?.split("|")[1];
    if (code) rows = rows.filter((resource) => "code" in resource && resource.code?.coding?.some((coding) => coding.code === code));
    const [system, value] = params?.identifier?.split("|") ?? [];
    if (system && value) rows = rows.filter((resource) => "identifier" in resource && resource.identifier?.some((identifier) =>
      identifier.system === system && identifier.value === value));
    return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource: resource as T })) };
  }
  async create<T extends Basic | Observation | ServiceRequest | CarePlan>(resource: T, headers?: Record<string, string>): Promise<T> {
    const conditional = headers?.["If-None-Exist"]?.replace(/^identifier=/, "");
    if (conditional) {
      const [system, value] = conditional.split("|");
      const existing = this.resources.find((candidate) => "identifier" in candidate && candidate.identifier?.some((identifier) =>
        identifier.system === system && identifier.value === value));
      if (existing) return existing as T;
    }
    const saved = { ...resource, id: resource.id ?? `resource-${this.next++}` };
    this.resources.push(saved); this.writes.push(saved);
    return saved;
  }
  async update<T extends Basic>(resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    const saved = { ...resource, id };
    const index = this.resources.findIndex((candidate) => candidate.resourceType === resourceType && candidate.id === id);
    if (index >= 0) this.resources[index] = saved;
    this.writes.push(saved);
    return saved;
  }
  async read<T extends Observation | ServiceRequest | CarePlan | Condition>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((candidate) => candidate.resourceType === resourceType && candidate.id === id);
    if (!resource) throw new Error(`${resourceType}/${id} not found`);
    return resource as T;
  }
}

function endpointDeps(fhir: EndpointFhir, actorRole: "clinician" | "auditor" = "clinician") {
  return {
    authenticate: async () => ({ staffReference: "Practitioner/test", actorRole, fhir }),
    now: () => "2026-07-18T12:00:00.000Z",
  };
}

function confirmedCondition(): Condition {
  return {
    resourceType: "Condition", id: "c1", subject: { reference: "Patient/patient-1" },
    encounter: { reference: "Encounter/enc-1" }, code: { coding: [{ code: "H40.021" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
  };
}

function applyBody(code: string) {
  return {
    protocolId: GLAUCOMA_SUSPECT_PROTOCOL.id, encounterId: "enc-1", patientId: "patient-1",
    diagnosis: { reference: "Condition/c1", code, confirmed: true },
  };
}

test("signing abandons an unconfirmed application and deletes all proposed findings", async () => {
  const { service } = harness();
  await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL);
  const opened = await service.open(GLAUCOMA_SUSPECT_PROTOCOL.id, {
    encounterId: "enc-sign", patientId: "patient-1",
    diagnosis: { reference: "Condition/c1", code: "H40.021", confirmed: true },
    actor: "Practitioner/test",
  });
  assert.equal((await service.findings.list()).filter((row) => row.state === "proposed").length, 14);
  assert.equal(await service.abandonOpenForSignedEncounter("enc-sign"), 1);
  assert.equal((await service.findings.list()).filter((row) =>
    row.encounterId === "enc-sign" && row.state === "proposed"
  ).length, 0);
  assert.equal((await service.findings.list()).filter((row) =>
    row.encounterId === "enc-sign" && row.state === "removed"
  ).length, 14);
  assert.equal((await service.applications.get(opened.application.id))?.undoState, "unapplied");
});
