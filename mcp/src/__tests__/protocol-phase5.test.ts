import assert from "node:assert/strict";
import test from "node:test";
import type { Basic, Bundle } from "@medplum/fhirtypes";
import { GLAUCOMA_SUSPECT_CHARGE_RULES, GLAUCOMA_SUSPECT_PROTOCOL } from "../clinical-graph/protocol-fixtures.js";
import { PROTOCOL_BASIC_CODES, ProtocolBasicStore, type ProtocolFhirClient } from "../clinical-graph/protocol-store.js";
import { committedFindingEvidence, ProtocolService } from "../clinical-graph/protocol-service.js";
import type { PlanActionInstance, ProcedureChargeRule } from "../clinical-graph/protocol-types.js";

class MemoryFhir implements ProtocolFhirClient {
  rows: Basic[] = [];
  headers: Array<Record<string, string> | undefined> = [];
  next = 1;

  async search<T extends Basic>(_type: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>> {
    const code = params?.code?.split("|")[1];
    const rows = code ? this.rows.filter((row) => row.code?.coding?.some((coding) => coding.code === code)) : this.rows;
    return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource: resource as T })) };
  }
  async create<T extends Basic>(resource: T, headers?: Record<string, string>): Promise<T> {
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
  assert.equal(fhir.headers.every((headers) => headers?.["X-ODOS-Source"] === "protocol-module"), true);
  assert.deepEqual(Object.values(PROTOCOL_BASIC_CODES).sort(), [
    "odos-charge-proposal", "odos-finding-instance", "odos-plan-action-instance",
    "odos-procedure-charge-rule", "odos-protocol-application", "odos-protocol-definition",
  ]);
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
  assert.equal(projectedFindings.length, 14);
  const committedGonio = (await service.findings.list()).filter((row) =>
    row.findingDefKey === "gonio_angle_structures" && row.state === "committed"
  );
  assert.equal(committedGonio.length, 8);
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
  assert.equal(projectedFindings.length, 14);
  assert.equal((await service.charges.list()).length, 5);
  assert.equal(materialized.length, 7);

  await service.commit(opened.application.id, [], ["Condition/c-retry"]);

  assert.equal(projectedFindings.length, 14);
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
