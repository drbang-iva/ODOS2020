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

test("E2 seeds ten entrance definitions with canonical Pachymetry and declarative documentation elements", () => {
  const seeds = buildFindingDefinitionSeeds();
  const entrance = seeds.filter((definition) => definition.sectionKey?.startsWith("entrance:"));
  assert.deepEqual(entrance.map((definition) => definition.stableKey), [
    "entrance:pupils",
    "entrance:stereo",
    "entrance:color",
    "entrance:eom",
    "entrance:cvf",
    "entrance:visual-field-defect",
    "entrance:cover",
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
    ["entrance.eom"],
    ["entrance.cvf"],
    ["entrance.visual-field-defect"],
    ["entrance.cover"],
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
  const pupils = entrance.find((definition) => definition.stableKey === "entrance:pupils");
  const stereo = entrance.find((definition) => definition.stableKey === "entrance:stereo");
  const color = entrance.find((definition) => definition.stableKey === "entrance:color");
  const cvf = entrance.find((definition) => definition.stableKey === "entrance:cvf");
  assert.ok(pupils && stereo && color && cvf);
  const pupilFields = pupils.valueSchema.fields as Record<string, Record<string, unknown>>;
  assert.deepEqual(
    ["CUSTOM_PUPIL_SIZE_BRIGHT", "CUSTOM_PUPIL_SIZE_DIM", "CUSTOM_PUPIL_SIZE_NEAR"].map((code) => [pupilFields[code]?.min, pupilFields[code]?.max, pupilFields[code]?.step]),
    [[1, 9, 0.5], [1, 9, 0.5], [1, 9, 0.5]],
  );
  const retiredApdCode = ["CUSTOM", "PUPIL", "APD"].join("_");
  assert.equal(retiredApdCode in pupilFields, false);
  assert.equal(pupilFields.CUSTOM_PUPIL_RAPD?.localCode, "CUSTOM_PUPIL_RAPD");
  assert.equal(pupilFields.CUSTOM_PUPIL_RAPD?.display, "RAPD");
  assert.deepEqual(
    ((pupilFields.CUSTOM_PUPIL_RAPD?.options ?? []) as Array<{ display: string }>).map((option) => option.display),
    ["none", "trace", "1+", "2+", "3+", "4+", "reverse"],
  );
  assert.equal(pupilFields.CUSTOM_PUPIL_NEUTRAL_DENSITY?.localCode, "CUSTOM_PUPIL_NEUTRAL_DENSITY");
  assert.equal(pupilFields.CUSTOM_PUPIL_NEUTRAL_DENSITY?.display, "Neutral density (log units)");
  assert.deepEqual(
    ((pupilFields.CUSTOM_PUPIL_NEUTRAL_DENSITY?.options ?? []) as Array<{ display: string }>).map((option) => option.display),
    ["none", "0.3", "0.6", "0.9", "1.2"],
  );
  assert.equal(pupils.sourceStatus, "unseeded-needs-operator-input");
  assert.equal(stereo.valueSchema.perEye, false);
  assert.equal(stereo.sourceStatus, "unseeded-needs-operator-input");
  assert.deepEqual(
    ((stereo.valueSchema.fields as Record<string, { options?: Array<{ display: string }> }>).CUSTOM_STEREO_TEST?.options ?? []).map((option) => option.display),
    ["Stereo Fly", "Random Dot", "Randot", "Reindeer", "Titmus Stereo Test"],
  );
  assert.deepEqual((stereo.valueSchema.fields as Record<string, { options?: unknown[] }>).CUSTOM_STEREO_ARC_SECONDS?.options, []);
  assert.equal(color.sourceStatus, "unseeded-needs-operator-input");
  assert.deepEqual(
    ((color.valueSchema.fields as Record<string, { options?: Array<{ code: string }> }>).CUSTOM_COLOR_PLATES_CORRECT?.options ?? []).map((option) => option.code),
    ["1", "2", "3", "4", "5", "6", "7"],
  );
  const cvfFields = cvf.valueSchema.fields as Record<string, unknown>;
  const retiredCenterCode = ["CUSTOM", "CVF", "CENTER"].join("_");
  assert.equal(retiredCenterCode in cvfFields, false);
  assert.deepEqual(
    Object.keys(cvfFields).filter((code) => code.startsWith("CUSTOM_CVF_") && !code.endsWith("METHOD") && !code.endsWith("UNABLE")),
    ["CUSTOM_CVF_UPPER_LEFT", "CUSTOM_CVF_UPPER_RIGHT", "CUSTOM_CVF_LOWER_LEFT", "CUSTOM_CVF_LOWER_RIGHT"],
  );
});

test("DE-1 seeds seven new definitions and references the one existing TBUT stable key as the eighth workup section", () => {
  const seeds = buildFindingDefinitionSeeds();
  const dryEye = seeds.filter((definition) => definition.sectionKey?.startsWith("dry-eye:"));
  assert.deepEqual(dryEye.map((definition) => definition.stableKey), [
    "dry-eye:symptoms",
    "dry-eye:tear-volume",
    "dry-eye:markers",
    "dry-eye:gland-structure",
    "dry-eye:gland-function",
    "dry-eye:conjunctival-staining",
    "dry-eye:staging",
  ]);
  assert.equal(seeds.some((definition) => definition.stableKey === "dry-eye:tear-stability"), false);
  const tearFilm = seeds.filter(
    (definition) => definition.stableKey === "ocular-health:anterior:tear-film",
  );
  assert.equal(tearFilm.length, 1);
  assert.equal(tearFilm[0]?.valueSchema.perEye, true);
  const tearFields = tearFilm[0]?.valueSchema.fields as Record<
    string,
    { display?: string; valueType?: string; unit?: string }
  >;
  assert.deepEqual(
    Object.values(tearFields)
      .filter((field) => field.display === "TBUT" || field.display === "TBUT method")
      .map((field) => [field.display, field.valueType, field.unit]),
    [
      ["TBUT", "number", "s"],
      ["TBUT method", "select", undefined],
    ],
  );
  const cornea = seeds.find(
    (definition) => definition.stableKey === "ocular-health:anterior:cornea",
  );
  assert.ok(cornea);
  assert.deepEqual(
    Object.values(cornea.valueSchema.fields as Record<string, { display?: string }>)
      .map((field) => field.display)
      .filter((display) => display?.includes("staining") || display === "Vital dye"),
    ["Vital dye"],
  );
  const abnormalFindings = Object.values(
    cornea.valueSchema.fields as Record<
      string,
      {
        display?: string;
        options?: Array<{
          code: string;
          qualifiers?: Array<{ display: string }>;
        }>;
      }
    >,
  ).find((field) => field.display === "Abnormal findings");
  const spk = abnormalFindings?.options?.find(
    (finding) => finding.code === "superficial-punctate-keratitis-spk",
  );
  assert.deepEqual(
    spk?.qualifiers?.map((qualifier) => qualifier.display),
    [
      "Corneal staining grade (grading scheme provisional)",
      "Corneal staining zone (grading scheme provisional)",
    ],
  );
  for (const stableKey of [
    "dry-eye:symptoms",
    "dry-eye:tear-volume",
    "dry-eye:markers",
    "dry-eye:gland-function",
    "dry-eye:staging",
  ]) {
    assert.equal(
      dryEye.find((definition) => definition.stableKey === stableKey)
        ?.normalSemantics?.template,
      undefined,
      stableKey,
    );
  }
  const conjunctival = dryEye.find(
    (definition) => definition.stableKey === "dry-eye:conjunctival-staining",
  );
  assert.equal(conjunctival?.normalSemantics?.template, "No conjunctival staining.");
  const diagnosisMapped = dryEye.filter(
    (definition) => definition.diagnosisCandidates?.length,
  );
  assert.deepEqual(diagnosisMapped.map((definition) => definition.stableKey), [
    "dry-eye:markers",
    "dry-eye:gland-function",
    "dry-eye:conjunctival-staining",
    "dry-eye:staging",
  ]);
  assert.equal(
    diagnosisMapped.flatMap((definition) => definition.diagnosisCandidates ?? [])
      .every((candidate) =>
        candidate.origin === "seed" &&
        candidate.active &&
        !("verificationStatus" in candidate)
      ),
    true,
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
    endpointDeps("provider", definitions),
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
  const result = await handleRefractionCaptureRequest(endpointDeps("provider", definitions), {
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

  assert.equal(clinicalRoutes.length, 91);
  assert.equal(routeDependencies.length, 43);
  assert.equal(procedureRouteDependencies.length, 6);
  assert.match(source, /handleImagingCaptureRequest\(\s*\{\s*authenticate: authenticateStaffRouteForAction\("chart\.write"\),\s*binaryAttempts: imagingBinaryAttemptStore,\s*\}/);
  assert.match(source, /handleImagingListRequest\(\s*\{\s*authenticate: authenticateStaffRouteForAction\("chart\.read"\),\s*binaryAttempts: imagingBinaryAttemptStore,\s*\}/);
  assert.match(source, /handleImagingStructureRefinementRequest\(\s*\{\s*authenticate: authenticateStaffRouteForAction\("chart\.write"\),\s*binaryAttempts: imagingBinaryAttemptStore,\s*\}/);
  assert.match(source, /handleDiagnosisCatalogListRequest/);
  assert.match(source, /handleDiagnosisCandidatesRequest/);
  assert.match(source, /handleDiagnosisFindingsReadRequest/);
  assert.match(source, /handleDiagnosisFindingsMutationRequest/);
  assert.match(source, /handleDiagnosisCompletenessRequest/);
  assert.match(source, /handleDiagnosisPickRequest/);
  assert.match(source, /handleDiagnosisQuickListRequest/);
  assert.match(source, /handleDiagnosisQuickListMutationRequest/);
  assert.match(source, /handleDiagnosisVisitStatusListRequest/);
  assert.match(source, /handleDiagnosisVisitStatusUpdateRequest/);
  assert.match(source, /handleDiagnosisOrderRequest/);
  assert.match(source, /handleComplaintDefinitionCatalogRequest/);
  assert.match(source, /handleComplaintDefinitionMutationRequest/);
  assert.match(source, /handleEncounterComplaintListRequest/);
  assert.match(source, /handleEncounterComplaintMutationRequest/);
  assert.match(source, /handleFindingSectionGroupCatalogRequest/);
  assert.match(source, /handleFindingSectionGroupCreationRequest/);
  assert.match(source, /handleFindingSectionGroupMutationRequest/);
  assert.match(source, /handleEncounterSectionOverrideMutationRequest/);
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
