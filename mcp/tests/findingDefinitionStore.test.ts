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
  searchCount = 0;
  beforeSearch?: (searchCount: number) => void;
  readonly writes: Array<{
    operation: "create" | "update";
    headers?: Record<string, string>;
  }> = [];

  async search<T extends Basic>(): Promise<Bundle<T>> {
    this.searchCount += 1;
    this.beforeSearch?.(this.searchCount);
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

test("E1 seeds six entrance definitions with canonical Pachymetry and declarative documentation elements", () => {
  const seeds = buildFindingDefinitionSeeds();
  const entrance = seeds.filter((definition) => definition.sectionKey?.startsWith("entrance:"));
  assert.deepEqual(entrance.map((definition) => definition.stableKey), [
    "entrance:pupils",
    "entrance:stereo",
    "entrance:color",
    "pachymetry_um",
    "manual_keratometry",
    "entrance:dilation",
  ]);
  assert.equal(seeds.filter((definition) => definition.stableKey === "pachymetry_um").length, 1);
  assert.equal(seeds.some((definition) => definition.stableKey === "pachymetry-cct"), false);
  assert.deepEqual(entrance.map((definition) => definition.documentationElements?.map((entry) => entry.code)), [
    ["entrance.pupils"],
    ["entrance.stereo"],
    ["entrance.color"],
    ["entrance.pachymetry"],
    [],
    ["entrance.dilation.dfe"],
  ]);
  const manualK = entrance.find((definition) => definition.stableKey === "manual_keratometry");
  assert.ok(manualK);
  const fields = manualK.valueSchema.fields as Record<string, Record<string, unknown>>;
  assert.deepEqual(
    ["CUSTOM_FLAT_K", "CUSTOM_STEEP_K"].map((code) => [fields[code]?.type, fields[code]?.minimum, fields[code]?.maximum, fields[code]?.precision]),
    [["decimal-input", 30, 60, 2], ["decimal-input", 30, 60, 2]],
  );
  assert.deepEqual(
    ["CUSTOM_FLAT_AXIS", "CUSTOM_STEEP_AXIS"].map((code) => [fields[code]?.type, fields[code]?.minimum, fields[code]?.maximum]),
    [["integer-select", 0, 180], ["integer-select", 0, 180]],
  );
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

test("save re-searches before create and updates a competing row that appeared", async () => {
  const fhir = new MemoryFindingDefinitionFhir();
  const seeds = buildFindingDefinitionSeeds();
  const refraction = seeds.find((definition) => definition.stableKey === "refraction");
  assert.ok(refraction);
  const competing = buildFindingDefinitionResource({
    ...refraction,
    display: "Competing write",
    sourceStatus: "local-practice",
    provenance: PROVENANCE,
  });
  competing.id = "row-race";
  fhir.beforeSearch = (searchCount) => {
    if (searchCount === 2) fhir.rows.push(competing);
  };

  const saved = await new FhirFindingDefinitionStore(fhir, seeds).save({
    ...refraction,
    display: "Requested write",
  }, PROVENANCE);

  assert.equal(fhir.searchCount, 2);
  assert.deepEqual(fhir.writes.map((write) => write.operation), ["update"]);
  assert.equal(saved.display, "Requested write");
  assert.equal(fhir.rows.length, 1);
});

test("bad rows are skipped and duplicates resolve by lastUpdated then id", async () => {
  const fhir = new MemoryFindingDefinitionFhir();
  const seeds = buildFindingDefinitionSeeds();
  const refraction = seeds.find((definition) => definition.stableKey === "refraction");
  assert.ok(refraction);
  const local = { ...refraction, sourceStatus: "local-practice" as const, provenance: PROVENANCE };
  const older = buildFindingDefinitionResource({ ...local, display: "Older" });
  older.id = "row-old";
  older.meta = { lastUpdated: "2026-07-10T12:00:00.000Z" };
  const tiedLowerId = buildFindingDefinitionResource({ ...local, display: "Tied lower id" });
  tiedLowerId.id = "row-a";
  tiedLowerId.meta = { lastUpdated: "2026-07-10T13:00:00.000Z" };
  const winner = buildFindingDefinitionResource({ ...local, display: "Deterministic winner" });
  winner.id = "row-z";
  winner.meta = { lastUpdated: "2026-07-10T13:00:00.000Z" };
  const garbage = buildFindingDefinitionResource(local);
  garbage.id = "row-garbage";
  garbage.extension![0]!.valueString = "{not-json";
  fhir.rows.push(garbage, older, winner, tiedLowerId);

  const { value: merged, errors } = await captureConsoleErrors(
    () => new FhirFindingDefinitionStore(fhir, seeds).list(),
  );

  assert.equal(merged.length, seeds.length);
  assert.equal(
    merged.find((definition) => definition.stableKey === "refraction")?.display,
    "Deterministic winner",
  );
  assert.equal(errors.some((message) => message.includes("Basic/row-garbage skipped")), true);
  assert.equal(
    errors.some((message) => message.includes("Basic/row-old skipped") && message.includes("Basic/row-z")),
    true,
  );
  assert.equal(
    errors.some((message) => message.includes("Basic/row-a skipped") && message.includes("Basic/row-z")),
    true,
  );
});

test("a handler still receives working definitions when one stored row is garbage", async () => {
  const fhir = new MemoryFindingDefinitionFhir();
  const seeds = buildFindingDefinitionSeeds();
  const refraction = seeds.find((definition) => definition.stableKey === "refraction");
  assert.ok(refraction);
  const edited = addRefractionTypeOption(refraction, {
    code: "SURVIVES_GARBAGE",
    display: "Survives garbage",
    active: true,
  });
  const good = buildFindingDefinitionResource({
    ...edited,
    sourceStatus: "local-practice",
    provenance: PROVENANCE,
  });
  good.id = "row-good";
  const garbage = buildFindingDefinitionResource({
    ...refraction,
    sourceStatus: "local-practice",
    provenance: PROVENANCE,
  });
  garbage.id = "row-garbage";
  garbage.extension![0]!.valueString = "{not-json";
  fhir.rows.push(garbage, good);

  const { value: definitions, errors } = await captureConsoleErrors(
    () => new FhirFindingDefinitionStore(fhir, seeds).list(),
  );
  const result = await handleRefractionCaptureRequest(endpointDeps("clinician", definitions), {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      blocks: [{ type: "SURVIVES_GARBAGE", OD: { sphere: -1 } }],
    },
  });

  assert.equal(result.status, 200);
  assert.equal(errors.some((message) => message.includes("Basic/row-garbage skipped")), true);
});

test("every definition-backed clinical-graph HTTP closure receives the persistent dependency", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const clinicalRoutes = source.match(/app\.(?:get|post|put)\("\/clinical-graph\//g) ?? [];
  const routeDependencies = source.match(/await clinicalGraphRouteDeps\(req\.header\("authorization"\), "[a-z.-]+"\)/g) ?? [];
  const procedureRouteDependencies = source.match(
    /await procedureDefinitionRouteDeps\(req\.header\("authorization"\), "[a-z.-]+"\)/g,
  ) ?? [];

  assert.equal(clinicalRoutes.length, 59);
  assert.equal(routeDependencies.length, 34);
  assert.equal(procedureRouteDependencies.length, 6);
  assert.match(source, /handleImagingCaptureRequest\(\s*\{ authenticate: authenticateStaffRouteForAction\("chart\.write"\) \}/);
  assert.match(source, /handleDiagnosisCatalogListRequest/);
  assert.match(source, /handleDiagnosisCandidatesRequest/);
  assert.match(source, /handleDiagnosisCompletenessRequest/);
  assert.match(source, /handleDiagnosisPickRequest/);
  assert.match(source, /handleDiagnosisVisitStatusListRequest/);
  assert.match(source, /handleDiagnosisVisitStatusUpdateRequest/);
  assert.match(source, /handleComplaintDefinitionCatalogRequest/);
  assert.match(source, /handleComplaintDefinitionMutationRequest/);
  assert.match(source, /handleEncounterComplaintListRequest/);
  assert.match(source, /handleEncounterComplaintMutationRequest/);
  assert.match(source, /handleProtocolOffersRequest/);
  assert.match(source, /handleProtocolApplyRequest/);
  assert.match(source, /handleProtocolApplicationsRequest/);
  assert.match(source, /handleProtocolUnapplyRequest/);
  assert.match(source, /handleProtocolSignCleanupRequest/);
  assert.match(source, /handleProviderAssignmentRequest\([\s\S]*serviceFhir: fhir/);
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

async function captureConsoleErrors<T>(operation: () => Promise<T>): Promise<{
  value: T;
  errors: string[];
}> {
  const original = console.error;
  const errors: string[] = [];
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  try {
    return { value: await operation(), errors };
  } finally {
    console.error = original;
  }
}
