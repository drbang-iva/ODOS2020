import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  createCustomField,
  updateCustomField,
  updatePickerConfiguration,
  validateCustomFieldValues,
} from "../src/clinical-graph/custom-fields.js";
import {
  handleFindingDefinitionCatalogRequest,
  handleFindingDefinitionMutationRequest,
} from "../src/clinical-graph/finding-definition-endpoint.js";
import {
  FhirFindingDefinitionStore,
  FINDING_DEFINITION_WRITE_HEADERS,
  buildFindingDefinitionSeeds,
  type FindingDefinitionFhirClient,
} from "../src/clinical-graph/finding-definition-store.js";
import {
  buildSpecialtyContactLensFindingDefinitionStub,
} from "../src/clinical-graph/contact-lens-definition.js";
import {
  handleSoftContactLensCaptureRequest,
  handleSpecialtyContactLensCaptureRequest,
} from "../src/clinical-graph/contact-lens-endpoint.js";
import { handleRefractionCaptureRequest } from "../src/clinical-graph/refraction-endpoint.js";
import { handleRefractionHistoryRequest } from "../src/clinical-graph/refraction-history-endpoint.js";
import {
  handleAutoRefractionCaptureRequest,
  handleWearingCaptureRequest,
} from "../src/clinical-graph/pretest-endpoint.js";
import type {
  ClinicalFindingDefinition,
  ClinicalGraphProvenance,
} from "../src/clinical-graph/glaucoma-suspect.js";

const AUTH = "Bearer good";
const PROVENANCE: ClinicalGraphProvenance = {
  source: "manual",
  recordedAt: "2026-07-10T15:00:00.000Z",
  actorReference: "Practitioner/admin-1",
};

test("custom field codes are minted once, survive rename, and fail closed by definition state", () => {
  const seed = specialtyDefinition();
  const created = createCustomField(seed, {
    display: "Skin Carotenoid Score",
    valueType: "number",
    min: 0,
    max: 100,
    step: 1,
  }, PROVENANCE, () => "abc12345");
  const code = created.field.localCode;
  const renamed = updateCustomField(created.definition, code, {
    display: "Carotenoid Score",
  }, PROVENANCE);

  assert.equal(code, "CUSTOM_SKIN_CAROTENOID_SCORE_abc12345");
  assert.equal(renamed.field.localCode, code);
  assert.equal(renamed.field.display, "Carotenoid Score");
  assert.match(String(validateCustomFieldValues([{ code, value: 50.5 }], renamed.definition, "OD")), /increments/);
  assert.match(String(validateCustomFieldValues([{ code: "CUSTOM_UNKNOWN_12345678", value: 1 }], renamed.definition, "OD")), /unknown code/);

  const inactive = updateCustomField(renamed.definition, code, { active: false }, PROVENANCE);
  assert.match(String(validateCustomFieldValues([{ code, value: 50 }], inactive.definition, "OD")), /inactive/);
});

test("select option codes cannot be removed or recoded after creation", () => {
  const created = createCustomField(specialtyDefinition(), {
    display: "Stable dropdown",
    valueType: "select",
    options: [{ code: "stable", display: "Stable", active: true }],
  }, PROVENANCE, () => "99999999");

  assert.throws(() => updateCustomField(created.definition, created.field.localCode, {
    options: [{ code: "changed", display: "Changed", active: true }],
  }, PROVENANCE), /deactivated instead of removed or recoded/);
});

test("practice admin grants creation through stored data and clinicians cannot mutate definitions", async () => {
  const fhir = new MemoryDefinitionFhir();
  const seeds = buildFindingDefinitionSeeds();
  const specialty = seeds.find((definition) => definition.stableKey === "specialty_contact_lens");
  assert.ok(specialty);
  const adminDeps = endpointDeps("admin", fhir, () => seeds);
  const clinicianDeps = endpointDeps("provider", fhir, () => seeds);

  const catalog = await handleFindingDefinitionCatalogRequest(clinicianDeps, { authHeader: AUTH });
  const denied = await handleFindingDefinitionMutationRequest(clinicianDeps, {
    authHeader: AUTH,
    params: { stableKey: "specialty_contact_lens" },
    body: { action: "set-picker-config", allowCreate: true },
  });
  const granted = await handleFindingDefinitionMutationRequest(adminDeps, {
    authHeader: AUTH,
    params: { stableKey: "specialty_contact_lens" },
    body: { action: "set-picker-config", allowCreate: true },
  });
  const stored = await new FhirFindingDefinitionStore(fhir, seeds).list();
  const created = await handleFindingDefinitionMutationRequest(
    endpointDeps("admin", fhir, () => stored),
    {
      authHeader: AUTH,
      params: { stableKey: "specialty_contact_lens" },
      body: {
        action: "create-custom-field",
        display: "Practice dropdown",
        valueType: "select",
        options: [{ code: "yes", display: "Yes", active: true }],
      },
    },
  );

  assert.equal(catalog.status, 200);
  assert.equal((catalog.body as { canWrite: boolean }).canWrite, false);
  assert.equal(denied.status, 403);
  assert.equal(granted.status, 200);
  assert.equal(created.status, 200);
  assert.match((created.body as { field: { localCode: string } }).field.localCode, /^CUSTOM_PRACTICE_DROPDOWN_[a-f0-9]{8}$/);
  assert.deepEqual(fhir.writeHeaders, [FINDING_DEFINITION_WRITE_HEADERS, FINDING_DEFINITION_WRITE_HEADERS]);
});

test("Review of Systems Add flag persists through the finding-definition mutation path across a store restart", async () => {
  const fhir = new MemoryDefinitionFhir();
  const seeds = buildFindingDefinitionSeeds();
  const result = await handleFindingDefinitionMutationRequest(
    endpointDeps("admin", fhir, () => seeds),
    {
      authHeader: AUTH,
      params: { stableKey: "hpi_ros" },
      body: {
        action: "add-field-option",
        fieldKey: "reviewOfSystems",
        code: "migraine",
        display: "Migraine",
        category: "general",
      },
    },
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));

  const restarted = await new FhirFindingDefinitionStore(fhir, seeds).list();
  const hpi = restarted.find((definition) => definition.stableKey === "hpi_ros");
  const options = ((hpi?.valueSchema.fields as Record<string, { options?: Array<{ code: string; display: string; category: string }> }>).reviewOfSystems?.options ?? []);
  assert.deepEqual(options.find((option) => option.code === "migraine"), {
    code: "migraine",
    display: "Migraine",
    active: true,
    category: "general",
  });
  assert.deepEqual(fhir.writeHeaders, [FINDING_DEFINITION_WRITE_HEADERS]);
});

test("specialty numeric and dropdown fields capture, rename, deactivate, and remain readable with C2 extras", async () => {
  let definition = specialtyDefinition();
  const number = createCustomField(definition, {
    display: "SCS-like score",
    valueType: "number",
    min: 0,
    max: 100,
    step: 1,
  }, PROVENANCE, () => "11111111");
  definition = number.definition;
  const select = createCustomField(definition, {
    display: "Fit grade",
    valueType: "select",
    options: [
      { code: "low", display: "Low", active: true },
      { code: "high", display: "High", active: true },
    ],
  }, PROVENANCE, () => "22222222");
  definition = select.definition;
  const fixture = clinicalFixture(() => [definition]);
  const captured = await handleSpecialtyContactLensCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      eyes: {
        OD: {
          manualEntry: true,
          manufacturer: "Local lab",
          product: "Local lens",
          additionalFields: [
            { code: "hvid", value: 11.8 },
            { code: "sag", value: 4200 },
          ],
          customFields: [
            { code: number.field.localCode, value: 72 },
            { code: select.field.localCode, value: "high" },
          ],
        },
      },
    },
  });
  const observation = fixture.observations[0];
  assert.equal(captured.status, 200);
  assert.equal(component(observation, number.field.localCode)?.valueQuantity?.value, 72);
  assert.equal(component(observation, select.field.localCode)?.valueCodeableConcept?.coding?.[0]?.code, "high");

  definition = updateCustomField(definition, number.field.localCode, {
    display: "Renamed SCS score",
    active: false,
  }, PROVENANCE).definition;
  fixture.setDefinitions(() => [definition]);
  const history = await handleRefractionHistoryRequest(fixture.historyDeps(), {
    authHeader: AUTH,
    query: { patient: "Patient/p1" },
  });
  const extras = (history.body as { specialtyCl: Array<{ extras: Array<{ code: string; label: string; value: unknown }> }> })
    .specialtyCl[0]?.extras ?? [];

  assert.equal(extras.find((extra) => extra.code === "SPECIALTY_HVID_MM")?.value, 11.8);
  assert.equal(extras.find((extra) => extra.code === "SPECIALTY_SAG")?.value, 4200);
  assert.equal(extras.find((extra) => extra.code === number.field.localCode)?.label, "Renamed SCS score");
  assert.equal(extras.find((extra) => extra.code === select.field.localCode)?.value, "High");

  const rejected = await handleSpecialtyContactLensCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      eyes: { OD: { customFields: [{ code: number.field.localCode, value: 72 }] } },
    },
  });
  assert.equal(rejected.status, 400);
  assert.match(String((rejected.body as { error: string }).error), /inactive/);
});

test("Wearing and refraction no longer hardcode manual source provenance", async () => {
  const fixture = clinicalFixture(() => buildFindingDefinitionSeeds());
  const wearing = await handleWearingCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      sourceType: "device",
      pairs: [{ eyeglassType: "progressives", OD: { sphere: -1 } }],
    },
  });
  const refraction = await handleRefractionCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      sourceType: "device",
      blocks: [{ type: "MANIFEST", OD: { sphere: -1 } }],
    },
  });
  const observations = fixture.observations;

  assert.equal(wearing.status, 200);
  assert.equal(refraction.status, 200);
  assert.equal(observations.filter((observation) => observation.note?.[0]?.text === "sourceType=device").length, 2);
});

test("generic customFields channels encode through refraction, soft CL, Wearing, and both auto definitions", async () => {
  let definitions = buildFindingDefinitionSeeds();
  const add = (stableKey: string, input: Parameters<typeof createCustomField>[1], id: string) => {
    const definition = definitions.find((candidate) => candidate.stableKey === stableKey);
    assert.ok(definition);
    const created = createCustomField(definition, input, PROVENANCE, () => id);
    definitions = definitions.map((candidate) => candidate.stableKey === stableKey ? created.definition : candidate);
    return created.field.localCode;
  };
  const refractionCode = add("refraction", { display: "Refraction custom", valueType: "number" }, "30000001");
  const softCode = add("soft_contact_lens", {
    display: "Soft custom",
    valueType: "select",
    options: [{ code: "choice", display: "Choice", active: true }],
  }, "30000002");
  const wearingCode = add("wearing_rx", { display: "Wearing custom", valueType: "number" }, "30000003");
  const autoRefCode = add("auto_refraction", { display: "AR custom", valueType: "number" }, "30000004");
  const autoKCode = add("auto_keratometry", {
    display: "K custom",
    valueType: "select",
    options: [{ code: "stable", display: "Stable", active: true }],
  }, "30000005");
  const fixture = clinicalFixture(() => definitions);

  assert.equal((await handleRefractionCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      blocks: [{ type: "MANIFEST", OD: { customFields: [{ code: refractionCode, value: 8 }] } }],
    },
  })).status, 200);
  assert.equal((await handleSoftContactLensCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      eyes: { OD: { customFields: [{ code: softCode, value: "choice" }] } },
    },
  })).status, 200);
  assert.equal((await handleWearingCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      pairs: [{ eyeglassType: "progressives", OD: { customFields: [{ code: wearingCode, value: 2 }] } }],
    },
  })).status, 200);
  const autoResult = await handleAutoRefractionCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      eyes: { OD: { customFields: [{ code: autoRefCode, value: 4 }, { code: autoKCode, value: "stable" }] } },
    },
  });
  assert.equal(autoResult.status, 200, JSON.stringify(autoResult.body));

  assert.equal(component(observationByCode(fixture.observations, "REFRACTION"), refractionCode)?.valueQuantity?.value, 8);
  assert.equal(component(observationByCode(fixture.observations, "soft_contact_lens"), softCode)?.valueCodeableConcept?.coding?.[0]?.code, "choice");
  assert.equal(component(observationByCode(fixture.observations, "wearing_rx"), `OD_${wearingCode}`)?.valueQuantity?.value, 2);
  assert.equal(component(observationByCode(fixture.observations, "auto_refraction"), autoRefCode)?.valueQuantity?.value, 4);
  assert.equal(component(observationByCode(fixture.observations, "auto_keratometry"), autoKCode)?.valueCodeableConcept?.coding?.[0]?.code, "stable");
});

class MemoryDefinitionFhir implements FindingDefinitionFhirClient {
  readonly rows: Basic[] = [];
  readonly writeHeaders: Array<Record<string, string> | undefined> = [];

  async search<T extends Basic>(): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: this.rows.map((resource) => ({ resource: resource as T })) };
  }

  async create<T extends Basic>(resource: T, headers?: Record<string, string>): Promise<T> {
    const saved = { ...resource, id: resource.id ?? `basic-${this.rows.length + 1}` };
    this.rows.push(saved);
    this.writeHeaders.push(headers);
    return saved;
  }

  async update<T extends Basic>(_resourceType: "Basic", id: string, resource: T, headers?: Record<string, string>): Promise<T> {
    const index = this.rows.findIndex((row) => row.id === id);
    this.rows[index] = { ...resource, id };
    this.writeHeaders.push(headers);
    return this.rows[index] as T;
  }
}

function endpointDeps(
  actorRole: PracticeRoleId,
  fhir: MemoryDefinitionFhir,
  findingDefinitions: () => ClinicalFindingDefinition[],
) {
  return {
    authenticate: async (authHeader: string | undefined) => authHeader === AUTH
      ? { staffReference: "Practitioner/admin-1", actorRole, fhir }
      : null,
    findingDefinitions,
    now: () => PROVENANCE.recordedAt,
  };
}

function specialtyDefinition(): ClinicalFindingDefinition {
  const seed = buildSpecialtyContactLensFindingDefinitionStub(PROVENANCE);
  return updatePickerConfiguration(seed, { allowCreate: true }, PROVENANCE);
}

function clinicalFixture(initialDefinitions: () => ClinicalFindingDefinition[]) {
  const observations: Observation[] = [];
  let definitions = initialDefinitions;
  const fhir = {
    create: async <T extends Observation | Provenance>(resource: T): Promise<T> => {
      const saved = { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${observations.length + 1}` };
      if (saved.resourceType === "Observation") observations.push(saved);
      return saved as T;
    },
    search: async <T extends Observation>(_resourceType: "Observation", params: Record<string, string> = {}): Promise<Bundle<T>> => {
      const [system, code] = params.code?.split("|") ?? [];
      const matches = observations
        .filter((observation) => observation.subject?.reference === params.subject)
        .filter((observation) => observation.code.coding?.some((coding) => coding.system === system && coding.code === code));
      return { resourceType: "Bundle", type: "searchset", entry: matches.map((resource) => ({ resource: resource as T })) };
    },
  };
  return {
    observations,
    setDefinitions(next: () => ClinicalFindingDefinition[]) {
      definitions = next;
    },
    captureDeps() {
      return {
        authenticate: async (authHeader: string | undefined) => authHeader === AUTH
          ? { staffReference: "Practitioner/doc-1", actorRole: "provider" as const, fhir }
          : null,
        findingDefinitions: () => definitions(),
        now: () => PROVENANCE.recordedAt,
      };
    },
    historyDeps() {
      return {
        authenticate: async (authHeader: string | undefined) => authHeader === AUTH
          ? { staffReference: "Practitioner/doc-1", actorRole: "provider" as const, fhir }
          : null,
        findingDefinitions: () => definitions(),
      };
    },
  };
}

function component(observation: Observation | undefined, code: string) {
  return observation?.component?.find((item) => item.code.coding?.some((coding) => coding.code === code));
}

function observationByCode(observations: Observation[], code: string): Observation | undefined {
  return observations.find((observation) => observation.code.coding?.some((coding) => coding.code === code));
}
