import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Basic, Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  FhirFindingDefinitionStore,
  FINDING_DEFINITION_CODE,
  FINDING_DEFINITION_CODE_SYSTEM,
  FINDING_DEFINITION_EXTENSION_URL,
  FINDING_DEFINITION_IDENTIFIER_SYSTEM,
  FINDING_DEFINITION_WRITE_HEADERS,
  buildFindingDefinitionResource,
  buildFindingDefinitionSeeds,
  parseFindingDefinitionResource,
  type FindingDefinitionFhirClient,
} from "../src/clinical-graph/finding-definition-store.js";
import type {
  ClinicalFindingDefinition,
  ClinicalGraphProvenance,
} from "../src/clinical-graph/glaucoma-suspect.js";
import {
  handleRefractionCaptureRequest,
  type RefractionEndpointDeps,
} from "../src/clinical-graph/refraction-endpoint.js";
import { addRefractionTypeOption } from "../src/clinical-graph/refraction-suspect.js";

const AUTH = "Bearer good";
const PROVENANCE: ClinicalGraphProvenance = {
  source: "manual",
  recordedAt: "2026-07-10T15:00:00.000Z",
  actorReference: "Practitioner/admin-1",
};

class MemoryFindingDefinitionFhir implements FindingDefinitionFhirClient {
  readonly rows: Basic[] = [];
  readonly writes: Array<{
    operation: "create" | "update";
    headers?: Record<string, string>;
  }> = [];

  async search<T extends Basic>(): Promise<Bundle<T>> {
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: this.rows.map((resource) => ({ resource: resource as T })),
    };
  }

  async create<T extends Basic>(
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T> {
    const persisted = { ...resource, id: resource.id ?? `finding-row-${this.rows.length + 1}` };
    this.rows.push(persisted);
    this.writes.push({ operation: "create", headers });
    return persisted;
  }

  async update<T extends Basic>(
    _resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T> {
    const index = this.rows.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`Missing Basic/${id}`);
    const persisted = { ...resource, id };
    this.rows[index] = persisted;
    this.writes.push({ operation: "update", headers });
    return persisted;
  }
}

test("finding definitions persist as one coded Basic carrying the interface JSON verbatim", () => {
  const seed = buildFindingDefinitionSeeds().find((definition) => definition.stableKey === "refraction");
  assert.ok(seed);
  const local = { ...seed, sourceStatus: "local-practice" as const, provenance: PROVENANCE };
  const resource = buildFindingDefinitionResource(local);

  assert.equal(resource.code?.coding?.[0]?.system, FINDING_DEFINITION_CODE_SYSTEM);
  assert.equal(resource.code?.coding?.[0]?.code, FINDING_DEFINITION_CODE);
  assert.equal(resource.identifier?.[0]?.system, FINDING_DEFINITION_IDENTIFIER_SYSTEM);
  assert.equal(resource.identifier?.[0]?.value, "refraction");
  assert.equal(resource.extension?.[0]?.url, FINDING_DEFINITION_EXTENSION_URL);
  assert.deepEqual(parseFindingDefinitionResource(resource), local);
});

test("stored rows override compiled seeds by stableKey and survive a store restart", async () => {
  const fhir = new MemoryFindingDefinitionFhir();
  const seeds = buildFindingDefinitionSeeds();
  const refraction = seeds.find((definition) => definition.stableKey === "refraction");
  assert.ok(refraction);
  const edited = addRefractionTypeOption(refraction, {
    code: "SUBJECTIVE_CUSTOM",
    display: "Subjective custom",
    active: true,
  });

  const firstProcess = new FhirFindingDefinitionStore(fhir, seeds);
  const saved = await firstProcess.save(edited, PROVENANCE);
  const restartedProcess = new FhirFindingDefinitionStore(fhir, seeds);
  const merged = await restartedProcess.list();
  const restored = merged.find((definition) => definition.stableKey === "refraction");

  assert.equal(saved.sourceStatus, "local-practice");
  assert.equal(saved.provenance.actorReference, "Practitioner/admin-1");
  assert.deepEqual(fhir.writes, [{
    operation: "create",
    headers: FINDING_DEFINITION_WRITE_HEADERS,
  }]);
  assert.ok(fieldOptions(restored, "type").some((option) => option.code === "SUBJECTIVE_CUSTOM"));
  assert.deepEqual(
    merged.filter((definition) => definition.stableKey !== "refraction"),
    seeds.filter((definition) => definition.stableKey !== "refraction"),
  );
});

test("a persisted practice option drives capture validation through the runtime dependency", async () => {
  const fhir = new MemoryFindingDefinitionFhir();
  const seeds = buildFindingDefinitionSeeds();
  const refraction = seeds.find((definition) => definition.stableKey === "refraction");
  assert.ok(refraction);
  await new FhirFindingDefinitionStore(fhir, seeds).save(
    addRefractionTypeOption(refraction, {
      code: "SUBJECTIVE_CUSTOM",
      display: "Subjective custom",
      active: true,
    }),
    PROVENANCE,
  );
  const restartedStore = new FhirFindingDefinitionStore(fhir, seeds);
  const definitions = await restartedStore.list();
  const result = await handleRefractionCaptureRequest(
    endpointDeps("clinician", definitions),
    {
      authHeader: AUTH,
      body: {
        patientReference: "Patient/p1",
        encounterReference: "Encounter/e1",
        blocks: [{ type: "SUBJECTIVE_CUSTOM", OD: { sphere: -1 } }],
      },
    },
  );

  assert.equal(result.status, 200);
});

test("saving again updates the same Basic and deactivation materializes active false", async () => {
  const fhir = new MemoryFindingDefinitionFhir();
  const seeds = buildFindingDefinitionSeeds();
  const store = new FhirFindingDefinitionStore(fhir, seeds);
  const refraction = seeds.find((definition) => definition.stableKey === "refraction");
  assert.ok(refraction);

  await store.save({ ...refraction, display: "Local refraction" }, PROVENANCE);
  const deactivated = await store.deactivate("refraction", {
    ...PROVENANCE,
    recordedAt: "2026-07-10T16:00:00.000Z",
  });

  assert.equal(fhir.rows.length, 1);
  assert.deepEqual(fhir.writes.map((write) => write.operation), ["create", "update"]);
  assert.equal(deactivated.active, false);
  assert.equal((await store.list()).find((definition) => definition.stableKey === "refraction")?.active, false);
});

test("the store fails closed on malformed and duplicate persisted rows", async () => {
  const fhir = new MemoryFindingDefinitionFhir();
  const seeds = buildFindingDefinitionSeeds();
  const refraction = seeds.find((definition) => definition.stableKey === "refraction");
  assert.ok(refraction);
  const local = { ...refraction, sourceStatus: "local-practice" as const, provenance: PROVENANCE };
  const first = buildFindingDefinitionResource(local);
  first.id = "row-1";
  const duplicate = buildFindingDefinitionResource(local);
  duplicate.id = "row-2";
  fhir.rows.push(first, duplicate);

  await assert.rejects(() => new FhirFindingDefinitionStore(fhir, seeds).list(), /Duplicate stableKey refraction/);

  fhir.rows.splice(0, fhir.rows.length, first);
  first.extension![0]!.valueString = "{not-json";
  await assert.rejects(() => new FhirFindingDefinitionStore(fhir, seeds).list(), /JSON is malformed/);
});

test("every clinical-graph HTTP closure receives the persistent finding-definition dependency", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const clinicalRoutes = source.match(/app\.(?:get|post)\("\/clinical-graph\//g) ?? [];
  const routeDependencies = source.match(/await clinicalGraphRouteDeps\(req\.header\("authorization"\)\)/g) ?? [];

  assert.equal(clinicalRoutes.length, 18);
  assert.equal(routeDependencies.length, clinicalRoutes.length);
});

function endpointDeps(
  actorRole: PracticeRoleId,
  definitions: ClinicalFindingDefinition[],
): RefractionEndpointDeps {
  return {
    authenticate: async (header) => header === AUTH ? {
      staffReference: "Practitioner/doc-1",
      actorRole,
      fhir: {
        create: async <T extends Observation | Provenance>(resource: T): Promise<T> => ({
          ...resource,
          id: resource.id ?? `${resource.resourceType.toLowerCase()}-1`,
        }),
      },
    } : null,
    findingDefinitions: () => definitions,
    now: () => "2026-07-10T15:00:00.000Z",
  };
}

function fieldOptions(
  definition: ClinicalFindingDefinition | undefined,
  fieldKey: string,
): Array<{ code?: string }> {
  const fields = definition?.valueSchema.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return [];
  const field = (fields as Record<string, unknown>)[fieldKey];
  if (!field || typeof field !== "object" || Array.isArray(field)) return [];
  const options = (field as Record<string, unknown>).options;
  return Array.isArray(options) ? options as Array<{ code?: string }> : [];
}
