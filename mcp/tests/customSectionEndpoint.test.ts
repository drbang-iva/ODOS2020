import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handleCustomSectionCaptureRequest,
  handleCustomSectionHistoryRequest,
} from "../src/clinical-graph/custom-section-endpoint.js";
import {
  handleFindingDefinitionCreationRequest,
  handleFindingDefinitionMutationRequest,
} from "../src/clinical-graph/finding-definition-endpoint.js";
import {
  FhirFindingDefinitionStore,
  buildFindingDefinitionSeeds,
} from "../src/clinical-graph/finding-definition-store.js";
import type { ClinicalFindingDefinition } from "../src/clinical-graph/glaucoma-suspect.js";

const AUTH = "Bearer good";
const NOW = "2026-07-10T18:00:00.000Z";

test("Skin Carotenoid Score creates, captures, reads, renames, and deactivates without changing its stable key", async () => {
  const fhir = new MemoryFhir();
  const denied = await handleFindingDefinitionCreationRequest(definitionDeps("clinician", fhir, "scs00000"), {
    authHeader: AUTH,
    body: scsDefinitionBody(),
  });
  assert.equal(denied.status, 403);

  const created = await handleFindingDefinitionCreationRequest(definitionDeps("practice-admin", fhir, "scs00000"), {
    authHeader: AUTH,
    body: scsDefinitionBody(),
  });
  assert.equal(created.status, 201);
  const createdBody = created.body as {
    definition: { stableKey: string; display: string; perEye: boolean };
    fields: Array<{ localCode: string }>;
  };
  const stableKey = createdBody.definition.stableKey;
  const localCode = createdBody.fields[0]!.localCode;
  assert.equal(stableKey, "custom:skin-carotenoid-score-scs00000");
  assert.equal(createdBody.definition.perEye, false);
  const definitions = await catalog(fhir);
  const definition = definitions.find((row) => row.stableKey === stableKey);
  assert.equal(definition?.notBillReady, true);

  const backdated = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey },
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      recordedAt: "2020-01-01T00:00:00.000Z",
      customFields: [{ code: localCode, value: 72 }],
    },
  });
  assert.equal(backdated.status, 400);
  assert.equal(fhir.observations.length, 0);

  const capture = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey },
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      customFields: [{ code: localCode, value: 72 }],
      remarks: "Discussed nutrition.",
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  assert.equal(fhir.observations.length, 1);
  assert.equal(component(fhir.observations[0], localCode)?.valueQuantity?.value, 72);
  assert.equal(component(fhir.observations[0], "REMARKS")?.valueString, "Discussed nutrition.");
  assert.deepEqual(fhir.captureWrites.map((write) => write.resourceType), ["Observation", "Provenance"]);
  assert.equal(fhir.captureWrites.every((write) => write.header === "mcp/save_section_observations"), true);
  const provenance = fhir.captureWrites.find((write) => write.resourceType === "Provenance")?.resource as Provenance;
  assert.equal(provenance.target?.[0]?.reference?.startsWith("Observation/"), true);
  assert.equal(provenance.target?.[1]?.reference, "Patient/p1");

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("clinician", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey },
    query: { patient: "Patient/p1" },
  });
  assert.equal(history.status, 200);
  assert.deepEqual((history.body as { rows: unknown[] }).rows, [{
    recordedAt: NOW,
    values: [{ code: localCode, label: "Score", value: 72 }],
    remarks: "Discussed nutrition.",
  }]);

  const renamed = await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-definition", display: "Carotenoid Score" },
  });
  assert.equal(renamed.status, 200);
  assert.equal((renamed.body as { definition: { stableKey: string; display: string } }).definition.stableKey, stableKey);
  assert.equal((renamed.body as { definition: { display: string } }).definition.display, "Carotenoid Score");

  const fieldRenamed = await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-custom-field", localCode, display: "SCS" },
  });
  assert.equal(fieldRenamed.status, 200);
  assert.equal((fieldRenamed.body as { field: { localCode: string } }).field.localCode, localCode);

  const deactivated = await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-definition", active: false },
  });
  assert.equal(deactivated.status, 200);
  const inactiveDefinitions = await catalog(fhir);
  const blocked = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, inactiveDefinitions), {
    authHeader: AUTH,
    params: { stableKey },
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      customFields: [{ code: localCode, value: 70 }],
    },
  });
  assert.equal(blocked.status, 404);
  assert.equal(fhir.observations.length, 1);

  await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-definition", active: true },
  });
  const reactivated = await catalog(fhir);
  const restoredHistory = await handleCustomSectionHistoryRequest(clinicalDeps("clinician", fhir, reactivated), {
    authHeader: AUTH,
    params: { stableKey },
    query: { patient: "Patient/p1" },
  });
  assert.equal(restoredHistory.status, 200);
  assert.equal((restoredHistory.body as { rows: unknown[] }).rows.length, 1);
});

test("per-eye custom sections prefix field components and read OD and OS independently", async () => {
  const fhir = new MemoryFhir();
  const created = await handleFindingDefinitionCreationRequest(definitionDeps("practice-admin", fhir, "eye00000"), {
    authHeader: AUTH,
    body: {
      action: "create-definition",
      display: "Tear Pattern",
      perEye: true,
      fields: [{
        display: "Pattern",
        valueType: "select",
        options: [
          { code: "stable", display: "Stable", active: true },
          { code: "unstable", display: "Unstable", active: true },
        ],
      }],
    },
  });
  const body = created.body as { definition: { stableKey: string }; fields: Array<{ localCode: string }> };
  const definitions = await catalog(fhir);
  const capture = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    body: {
      patientReference: "Patient/p2",
      encounterReference: "Encounter/e2",
      eyes: {
        OD: { customFields: [{ code: body.fields[0]!.localCode, value: "stable" }] },
        OS: { customFields: [{ code: body.fields[0]!.localCode, value: "unstable" }] },
      },
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  assert.equal(component(fhir.observations[0], `OD_${body.fields[0]!.localCode}`)?.valueCodeableConcept?.coding?.[0]?.code, "stable");
  assert.equal(component(fhir.observations[1], `OS_${body.fields[0]!.localCode}`)?.valueCodeableConcept?.coding?.[0]?.code, "unstable");

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("clinician", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    query: { patient: "Patient/p2" },
  });
  const rows = (history.body as { rows: Array<{ eye: string; values: Array<{ value: string }> }> }).rows;
  assert.deepEqual(rows.map((row) => [row.eye, row.values[0]?.value]), [["OD", "Stable"], ["OS", "Unstable"]]);

  const deniedRead = await handleCustomSectionHistoryRequest(clinicalDeps("auditor", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    query: { patient: "Patient/p2" },
  });
  const deniedWrite = await handleCustomSectionCaptureRequest(clinicalDeps("front-desk", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    body: {
      patientReference: "Patient/p2",
      encounterReference: "Encounter/e2",
      eyes: { OD: { customFields: [] } },
    },
  });
  assert.equal(deniedRead.status, 403);
  assert.equal(deniedWrite.status, 403);
});

class MemoryFhir {
  readonly basics: Basic[] = [];
  readonly observations: Observation[] = [];
  readonly captureWrites: Array<{ resourceType: string; header?: string; resource: Basic | Observation | Provenance }> = [];

  async search<T extends Basic | Observation>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const resources = resourceType === "Basic"
      ? this.basics
      : this.observations
        .filter((observation) => observation.subject?.reference === params.subject)
        .filter((observation) => {
          const [system, code] = params.code?.split("|") ?? [];
          return observation.code.coding?.some((coding) => coding.system === system && coding.code === code);
        });
    return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource: resource as T })) };
  }

  async create<T extends Basic | Observation | Provenance>(
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T> {
    const saved = { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.basics.length + this.observations.length + this.captureWrites.length + 1}` } as T;
    if (saved.resourceType === "Basic") this.basics.push(saved as Basic);
    if (saved.resourceType === "Observation") this.observations.push(saved as Observation);
    if (saved.resourceType !== "Basic") {
      this.captureWrites.push({ resourceType: saved.resourceType, header: headers?.["X-OSOD-Source"], resource: saved });
    }
    return saved;
  }

  async update<T extends Basic>(
    _resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    const index = this.basics.findIndex((row) => row.id === id);
    const saved = { ...resource, id };
    this.basics[index] = saved;
    return saved;
  }
}

function scsDefinitionBody() {
  return {
    action: "create-definition",
    display: "Skin Carotenoid Score",
    perEye: false,
    fields: [{ display: "Score", valueType: "number", min: 0, max: 100, step: 1 }],
  };
}

function definitionDeps(role: PracticeRoleId, fhir: MemoryFhir, shortId: string) {
  return {
    authenticate: async (authHeader: string | undefined) => authHeader === AUTH
      ? { staffReference: "Practitioner/admin-1", actorRole: role, fhir }
      : null,
    now: () => NOW,
    shortId: () => shortId,
  };
}

function clinicalDeps(role: PracticeRoleId, fhir: MemoryFhir, definitions: ClinicalFindingDefinition[]) {
  return {
    authenticate: async (authHeader: string | undefined) => authHeader === AUTH
      ? { staffReference: "Practitioner/doc-1", actorRole: role, fhir }
      : null,
    findingDefinitions: () => definitions,
    now: () => NOW,
  };
}

async function catalog(fhir: MemoryFhir): Promise<ClinicalFindingDefinition[]> {
  return new FhirFindingDefinitionStore(fhir, buildFindingDefinitionSeeds()).list();
}

function component(observation: Observation | undefined, code: string) {
  return observation?.component?.find((item) => item.code.coding?.some((coding) => coding.code === code));
}
