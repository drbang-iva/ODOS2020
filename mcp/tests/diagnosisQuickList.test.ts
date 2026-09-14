import { reseedCommonDiagnosisPins } from "../../scripts/reseed-common-diagnosis-pins.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import {
  handleDiagnosisQuickListMutationRequest,
  handleDiagnosisQuickListRequest,
  orderDiagnosisQuickList,
} from "../src/clinical-graph/diagnosis-quick-list-endpoint.js";
import {
  buildDiagnosisPickTallyResource,
  parseDiagnosisPickTallyResource,
  FhirDiagnosisPickTallyStore,
} from "../src/clinical-graph/diagnosis-pick-tally-store.js";
import { buildDiagnosisCatalogSeeds } from "../src/clinical-graph/diagnosis-catalog-store.js";
import type { DiagnosisCatalogRow } from "../src/clinical-graph/glaucoma-suspect.js";

const STARTER_DIAGNOSIS_KEYS = [
  "astigmatism",
  "myopia",
  "hyperopia",
  "cataract_nuclear_sclerosis",
  "kcs_not_sjogren",
  "ocular_hypertension",
  "pseudophakia",
  "glaucoma_suspect_open_angle_low",
  "glaucoma_suspect_open_angle_high",
  "hypertensive_retinopathy",
  "meibomian_gland_dysfunction",
  "primary-open-angle-glaucoma",
  "macular_drusen",
  "optic_disc_drusen",
] as const;

test("quick-list pins round-trip without changing per-finding usage counts", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.increment("Practitioner/doc", "finding-a", "myopia", "2026-08-09T12:00:00.000Z");
  await store.replacePinned(
    "Practitioner/doc",
    ["presbyopia", "myopia"],
    "2026-08-09T12:01:00.000Z",
  );

  assert.deepEqual(await store.read("Practitioner/doc"), {
    counts: { "finding-a": { myopia: 1 } },
    pinnedDiagnosisKeys: ["presbyopia", "myopia"],
    pinState: "custom",
    updatedAt: "2026-08-09T12:01:00.000Z",
  });
  await assert.rejects(
    store.replacePinned(
      "Practitioner/doc",
      ["myopia", "myopia"],
      "2026-08-09T12:02:00.000Z",
    ),
    /unique/,
  );
});

test("quick-list ordering puts manual pins before aggregate usage without clinical inference", () => {
  const diagnoses = buildDiagnosisCatalogSeeds().filter((row) =>
    ["myopia", "presbyopia", "pseudophakia"].includes(row.stableKey)
  );
  const ordered = orderDiagnosisQuickList(diagnoses, {
    counts: {
      "finding-a": { myopia: 2, pseudophakia: 1 },
      "finding-b": { myopia: 1, pseudophakia: 7 },
    },
    pinnedDiagnosisKeys: ["presbyopia"],
    updatedAt: "2026-08-09T12:00:00.000Z",
  });

  assert.deepEqual(ordered.map((row) => row.stableKey), [
    "presbyopia",
    "pseudophakia",
    "myopia",
  ]);
});

test("quick-list excludes an unused unpinned catalog even when it exceeds the Common cap", () => {
  const ordered = orderDiagnosisQuickList(diagnosisRows(20), {
    counts: {},
    pinnedDiagnosisKeys: [],
    updatedAt: "2026-08-10T12:00:00.000Z",
  });

  assert.deepEqual(ordered, []);
});

test("quick-list displays the first 20 doctor pins when stored pins exceed the cap", () => {
  const diagnoses = diagnosisRows(25);
  const pinnedDiagnosisKeys = diagnoses.slice(0, 24).map((row) => row.stableKey).reverse();
  const ordered = orderDiagnosisQuickList(diagnoses, {
    counts: {},
    pinnedDiagnosisKeys,
    updatedAt: "2026-08-10T12:00:00.000Z",
  });

  assert.deepEqual(ordered.map((row) => row.stableKey), pinnedDiagnosisKeys.slice(0, 20));
});

test("quick-list fills positive usage in descending order only to 20 total rows", () => {
  const diagnoses = diagnosisRows(20);
  const ordered = orderDiagnosisQuickList(diagnoses, {
    counts: {
      "finding-a": Object.fromEntries(diagnoses.map((row, index) => [row.stableKey, 20 - index])),
    },
    pinnedDiagnosisKeys: ["diagnosis-19", "diagnosis-18"],
    updatedAt: "2026-08-10T12:00:00.000Z",
  });

  assert.deepEqual(ordered.map((row) => row.stableKey), [
    "diagnosis-19",
    "diagnosis-18",
    "diagnosis-00",
    "diagnosis-01",
    "diagnosis-02",
    "diagnosis-03",
    "diagnosis-04",
    "diagnosis-05",
    "diagnosis-06",
    "diagnosis-07",
    "diagnosis-08",
    "diagnosis-09",
    "diagnosis-10",
    "diagnosis-11",
    "diagnosis-12",
    "diagnosis-13",
    "diagnosis-14",
    "diagnosis-15",
    "diagnosis-16",
    "diagnosis-17",
  ]);
});

test("staged diagnosis members collapse into four family entries in Common and Find dx", async () => {
  const fhir = new MemoryFhir();
  const diagnoses = buildDiagnosisCatalogSeeds();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.increment("Practitioner/doc", "finding-a", "poag_severe", "2026-08-11T12:00:00.000Z");
  const response = await handleDiagnosisQuickListRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doc", actorRole: "provider" }),
    tallyFhir: fhir,
    diagnosisCatalog: async () => diagnoses,
  }, { authHeader: "Bearer doc" });
  assert.equal(response.status, 200);
  const body = response.body as {
    diagnoses: Array<{ stableKey: string; display: string; axisLabel?: string }>;
    catalog: Array<{ stableKey: string; display: string; axisLabel?: string; members?: Array<{ stableKey: string; stageLabel: string }> }>;
  };
  const stagedMembers = new Set([
    "poag_mild", "poag_moderate", "poag_severe", "poag_indeterminate",
    "low_tension_glaucoma_mild", "low_tension_glaucoma_moderate", "low_tension_glaucoma_severe", "low_tension_glaucoma_indeterminate",
    "dry_amd_early", "dry_amd_intermediate", "dry_amd_advanced_atrophic_without_subfoveal", "dry_amd_advanced_atrophic_with_subfoveal",
    "wet_amd_active_cnv", "wet_amd_inactive_cnv", "wet_amd_inactive_scar",
  ]);
  assert.deepEqual(body.diagnoses.filter((row) => row.axisLabel).map((row) => [row.stableKey, row.display, row.axisLabel]), [
    ["primary-open-angle-glaucoma", "Primary open-angle glaucoma", "Stage"],
  ]);
  assert.deepEqual(body.catalog.filter((row) => row.axisLabel).map((row) => [row.stableKey, row.display, row.axisLabel]), [
    ["primary-open-angle-glaucoma", "Primary open-angle glaucoma", "Stage"],
    ["low-tension-glaucoma", "Low-tension glaucoma", "Stage"],
    ["nonexudative-amd", "Nonexudative AMD", "Stage"],
    ["exudative-amd", "Exudative AMD", "Activity"],
  ]);
  assert.equal(body.catalog.some((row) => stagedMembers.has(row.stableKey)), false);
  assert.deepEqual(
    body.catalog.find((row) => row.stableKey === "primary-open-angle-glaucoma")?.members?.map((member) => [member.stableKey, member.stageLabel]),
    [
      ["poag_mild", "Mild"],
      ["poag_moderate", "Moderate"],
      ["poag_severe", "Severe"],
      ["poag_indeterminate", "Indeterminate"],
    ],
  );
});

test("member pins migrate idempotently to staged families without dropping unrelated pins", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.replacePinned(
    "Practitioner/doc",
    ["poag_severe", "myopia", "wet_amd_active_cnv", "poag_mild"],
    "2026-08-11T12:00:00.000Z",
  );
  const deps = {
    authenticate: async () => ({ staffReference: "Practitioner/doc", actorRole: "provider" as const }),
    tallyFhir: fhir,
    diagnosisCatalog: async () => buildDiagnosisCatalogSeeds(),
    now: () => "2026-08-11T12:01:00.000Z",
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await handleDiagnosisQuickListRequest(deps, { authHeader: "Bearer doc" });
    assert.equal(response.status, 200);
    assert.deepEqual((response.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys, [
      "primary-open-angle-glaucoma",
      "myopia",
      "exudative-amd",
    ]);
  }
  assert.deepEqual((await store.read("Practitioner/doc"))?.pinnedDiagnosisKeys, [
    "primary-open-angle-glaucoma",
    "myopia",
    "exudative-amd",
  ]);
});

test("fresh writable practitioner receives starter Common diagnoses in operator order", async () => {
  const fhir = new MemoryFhir();
  const response = await handleDiagnosisQuickListRequest({
    authenticate: async () => ({ staffReference: "Practitioner/fresh", actorRole: "provider" }),
    tallyFhir: fhir,
    diagnosisCatalog: async () => buildDiagnosisCatalogSeeds(),
    now: () => "2026-08-17T12:00:00.000Z",
  }, { authHeader: "Bearer fresh" });

  assert.equal(response.status, 200);
  const body = response.body as {
    pinnedDiagnosisKeys: string[];
    diagnoses: Array<{ stableKey: string; pinned: boolean; axisLabel?: string }>;
  };
  assert.deepEqual(body.pinnedDiagnosisKeys, STARTER_DIAGNOSIS_KEYS);
  assert.deepEqual(body.diagnoses.map((row) => row.stableKey), STARTER_DIAGNOSIS_KEYS);
  const poag = body.diagnoses.find((row) => row.stableKey === "primary-open-angle-glaucoma");
  assert.equal(poag?.pinned, true);
  assert.equal(poag?.axisLabel, "Stage");
});

test("fresh Admin reads an honest empty quick list without attempting the writable seed", async () => {
  const fhir = new MemoryFhir();
  const response = await handleDiagnosisQuickListRequest({
    authenticate: async () => ({ staffReference: "Practitioner/admin", actorRole: "admin" }),
    tallyFhir: fhir,
    diagnosisCatalog: async () => buildDiagnosisCatalogSeeds(),
    now: () => "2026-08-17T12:00:00.000Z",
  }, { authHeader: "Bearer admin" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    canWrite: false,
    pinnedDiagnosisKeys: [],
    diagnoses: [],
    catalog: (response.body as { catalog: unknown[] }).catalog,
  });
  assert.equal(fhir.resources.length, 0, "read-only Admin must not create a tally while loading Common");
});

test("first-read initialization preserves clinician pins that win a conditional-create race", async () => {
  const fhir = new ConditionalCreateRaceFhir();
  const response = await handleDiagnosisQuickListRequest({
    authenticate: async () => ({ staffReference: "Practitioner/racing", actorRole: "provider" }),
    tallyFhir: fhir,
    diagnosisCatalog: async () => buildDiagnosisCatalogSeeds(),
    now: () => "2026-08-17T12:00:00.000Z",
  }, { authHeader: "Bearer racing" });

  assert.equal(response.status, 200);
  assert.deepEqual((response.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys, ["myopia"]);
  assert.deepEqual(
    (await new FhirDiagnosisPickTallyStore(fhir).read("Practitioner/racing"))?.pinnedDiagnosisKeys,
    ["myopia"],
  );
  assert.equal(fhir.updateCalls, 0);
});

for (const status of [409, 412] as const) {
  test(`first-read initialization rereads clinician pins after a conditional-create ${status}`, async () => {
    const fhir = new ConditionalCreateConflictFhir(status);
    const response = await handleDiagnosisQuickListRequest({
      authenticate: async () => ({ staffReference: "Practitioner/conflict", actorRole: "provider" }),
      tallyFhir: fhir,
      diagnosisCatalog: async () => buildDiagnosisCatalogSeeds(),
      now: () => "2026-08-17T12:00:00.000Z",
    }, { authHeader: "Bearer conflict" });

    assert.equal(response.status, 200);
    assert.deepEqual((response.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys, ["myopia"]);
    assert.deepEqual(
      (await new FhirDiagnosisPickTallyStore(fhir).read("Practitioner/conflict"))?.pinnedDiagnosisKeys,
      ["myopia"],
    );
    assert.equal(fhir.updateCalls, 0);
  });
}

test("first-read seed reports a configured diagnosis whose stable key is absent", async () => {
  const fhir = new MemoryFhir();
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => messages.push(values.map(String).join(" "));
  try {
    const response = await handleDiagnosisQuickListRequest({
      authenticate: async () => ({ staffReference: "Practitioner/gap", actorRole: "provider" }),
      tallyFhir: fhir,
      diagnosisCatalog: async () => buildDiagnosisCatalogSeeds().filter((row) => row.stableKey !== "astigmatism"),
      now: () => "2026-08-17T12:00:00.000Z",
    }, { authHeader: "Bearer gap" });

    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys,
      STARTER_DIAGNOSIS_KEYS.filter((key) => key !== "astigmatism"),
    );
    assert.deepEqual(messages, [
      'Diagnosis quick-list starter "Astigmatism" not seeded: stableKey "astigmatism" is not active and verified.',
    ]);
  } finally {
    console.error = originalError;
  }
});

test("unpinning the seeded POAG family survives reload and another seed trigger without crossing practitioners", async () => {
  const fhir = new MemoryFhir();
  const authenticate = async (header: string | undefined) => ({
    staffReference: header === "Bearer two" ? "Practitioner/two" : "Practitioner/one",
    actorRole: "provider" as const,
  });
  const deps = {
    authenticate,
    tallyFhir: fhir,
    diagnosisCatalog: async () => buildDiagnosisCatalogSeeds(),
    now: () => "2026-08-17T12:00:00.000Z",
  };

  const seeded = await handleDiagnosisQuickListRequest(deps, { authHeader: "Bearer one" });
  assert.deepEqual(
    (seeded.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys,
    STARTER_DIAGNOSIS_KEYS,
  );
  const store = new FhirDiagnosisPickTallyStore(fhir);
  assert.deepEqual((await store.read("Practitioner/one"))?.pinnedDiagnosisKeys, STARTER_DIAGNOSIS_KEYS);
  assert.equal(await store.read("Practitioner/two"), undefined);
  const withoutPoag = STARTER_DIAGNOSIS_KEYS.filter((key) => key !== "primary-open-angle-glaucoma");
  const unpinned = await handleDiagnosisQuickListMutationRequest(deps, {
    authHeader: "Bearer one",
    body: { pinnedDiagnosisKeys: withoutPoag },
  });
  assert.equal(unpinned.status, 200);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reloaded = await handleDiagnosisQuickListRequest(deps, { authHeader: "Bearer one" });
    assert.deepEqual(
      (reloaded.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys,
      withoutPoag,
    );
  }
  const other = await handleDiagnosisQuickListRequest(deps, { authHeader: "Bearer two" });
  assert.deepEqual(
    (other.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys,
    STARTER_DIAGNOSIS_KEYS,
  );
  assert.deepEqual((await store.read("Practitioner/one"))?.pinnedDiagnosisKeys, withoutPoag);
  assert.deepEqual((await store.read("Practitioner/two"))?.pinnedDiagnosisKeys, STARTER_DIAGNOSIS_KEYS);
});

test("quick-list routes isolate practitioner pins and reject unknown diagnoses", async () => {
  const fhir = new MemoryFhir();
  const diagnoses = buildDiagnosisCatalogSeeds();
  const authenticate = async (header: string | undefined) => {
    const staffReference = header === "Bearer one"
      ? "Practitioner/one"
      : header === "Bearer two"
      ? "Practitioner/two"
      : undefined;
    return staffReference
      ? { staffReference, actorRole: "provider" as const, fhir }
      : null;
  };
  const deps = {
    authenticate,
    tallyFhir: fhir,
    diagnosisCatalog: async () => diagnoses,
    now: () => "2026-08-09T12:00:00.000Z",
  };

  const saved = await handleDiagnosisQuickListMutationRequest(deps, {
    authHeader: "Bearer one",
    body: { pinnedDiagnosisKeys: ["presbyopia", "myopia"] },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(
    (saved.body as { diagnoses: Array<{ stableKey: string; pinned: boolean }> }).diagnoses
      .slice(0, 2)
      .map((row) => [row.stableKey, row.pinned]),
    [["presbyopia", true], ["myopia", true]],
  );

  const other = await handleDiagnosisQuickListRequest(deps, { authHeader: "Bearer two" });
  assert.equal(other.status, 200);
  const otherBody = other.body as {
    pinnedDiagnosisKeys: string[];
    diagnoses: Array<{ stableKey: string }>;
    catalog: Array<{ stableKey: string }>;
  };
  assert.deepEqual(
    otherBody.pinnedDiagnosisKeys,
    STARTER_DIAGNOSIS_KEYS,
  );
  assert.deepEqual(otherBody.diagnoses.map((row) => row.stableKey), STARTER_DIAGNOSIS_KEYS);
  const collapsedMembers = new Set([
    "poag_mild", "poag_moderate", "poag_severe", "poag_indeterminate",
    "low_tension_glaucoma_mild", "low_tension_glaucoma_moderate", "low_tension_glaucoma_severe", "low_tension_glaucoma_indeterminate",
    "dry_amd_early", "dry_amd_intermediate", "dry_amd_advanced_atrophic_without_subfoveal", "dry_amd_advanced_atrophic_with_subfoveal",
    "wet_amd_active_cnv", "wet_amd_inactive_cnv", "wet_amd_inactive_scar",
  ]);
  assert.deepEqual(new Set(otherBody.catalog.map((row) => row.stableKey)), new Set([
    ...diagnoses
      .filter((row) => row.active && row.codingStatus === "verified" && !collapsedMembers.has(row.stableKey))
      .map((row) => row.stableKey),
    "primary-open-angle-glaucoma",
    "low-tension-glaucoma",
    "nonexudative-amd",
    "exudative-amd",
  ]));

  const rejected = await handleDiagnosisQuickListMutationRequest(deps, {
    authHeader: "Bearer one",
    body: { pinnedDiagnosisKeys: ["not-a-diagnosis"] },
  });
  assert.equal(rejected.status, 400);
  assert.match(String((rejected.body as { error: string }).error), /not-a-diagnosis/);
});

class MemoryFhir {
  readonly baseUrl = "http://localhost:8103";
  async searchUrl(): Promise<Bundle<Basic>> { throw new Error("Unexpected page"); }
  readonly resources: Resource[] = [];
  writeCalls = 0;

  async search<T extends Basic>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const resources = this.resources.filter((resource) => {
      if (resource.resourceType !== resourceType) return false;
      const basic = resource as Basic;
      if (params.code && !basic.code.coding?.some((coding) =>
        `${coding.system}|${coding.code}` === params.code
      )) return false;
      if (params.identifier && !basic.identifier?.some((identifier) =>
        `${identifier.system}|${identifier.value}` === params.identifier
      )) return false;
      return true;
    });
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource: structuredClone(resource as T) })),
    };
  }

  async create<T extends Basic>(resource: T): Promise<T> {
    this.writeCalls += 1;
    const persisted = {
      ...resource,
      id: resource.id ?? `basic-${this.resources.length + 1}`,
      meta: { versionId: "1", lastUpdated: "2026-08-09T12:00:00.000Z" },
    } as T;
    this.resources.push(persisted);
    return structuredClone(persisted);
  }

  async update<T extends Basic>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    const index = this.resources.findIndex((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    if (index < 0) throw new Error(`Missing ${resourceType}/${id}`);
    const versionId = String(Number(this.resources[index]!.meta?.versionId ?? "0") + 1);
    this.writeCalls += 1;
    const persisted = {
      ...resource,
      id,
      meta: { versionId, lastUpdated: "2026-08-09T12:01:00.000Z" },
    } as T;
    this.resources[index] = persisted;
    return structuredClone(persisted);
  }
}

class ConditionalCreateRaceFhir extends MemoryFhir {
  updateCalls = 0;

  override async create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T> {
    if (extraHeaders?.["If-None-Exist"]) {
      return super.create(buildDiagnosisPickTallyResource("Practitioner/racing", {
        counts: {},
        pinnedDiagnosisKeys: ["myopia"],
        updatedAt: "2026-08-17T12:00:00.001Z",
      })) as Promise<T>;
    }
    return super.create(resource);
  }

  override async update<T extends Basic>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    this.updateCalls += 1;
    return super.update(resourceType, id, resource);
  }
}

class ConditionalCreateConflictFhir extends MemoryFhir {
  updateCalls = 0;

  constructor(private readonly status: 409 | 412) {
    super();
  }

  override async create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T> {
    if (extraHeaders?.["If-None-Exist"]) {
      await super.create(buildDiagnosisPickTallyResource("Practitioner/conflict", {
        counts: {},
        pinnedDiagnosisKeys: ["myopia"],
        updatedAt: "2026-08-17T12:00:00.001Z",
      }));
      const error = new Error(`FHIR ${this.status} conditional create conflict`) as Error & { status: number };
      error.status = this.status;
      throw error;
    }
    return super.create(resource);
  }

  override async update<T extends Basic>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    this.updateCalls += 1;
    return super.update(resourceType, id, resource);
  }
}

function diagnosisRows(count: number): DiagnosisCatalogRow[] {
  const template = buildDiagnosisCatalogSeeds()[0]!;
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    id: `diagnosis-${index}`,
    stableKey: `diagnosis-${String(index).padStart(2, "0")}`,
    display: `Diagnosis ${String(index).padStart(2, "0")}`,
  }));
}

function quickListDeps(fhir: MemoryFhir, actorRole: "provider" | "admin" = "provider") {
  return {
    authenticate: async () => ({ staffReference: "Practitioner/guard", actorRole }),
    tallyFhir: fhir,
    diagnosisCatalog: async () => buildDiagnosisCatalogSeeds(),
    now: () => "2026-09-14T12:00:00.000Z",
  };
}

function legacyTallyFormat(fhir: MemoryFhir, missingPins = false): void {
  for (const resource of fhir.resources as Basic[]) {
    const extension = resource.extension!.find((entry) => entry.valueString)!;
    const row = JSON.parse(extension.valueString!);
    delete row.pinState;
    if (missingPins) delete row.pinnedDiagnosisKeys;
    extension.valueString = JSON.stringify(row);
  }
}

test("G1 Common returns 20 eligible usage rows", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  const diagnoses = diagnosisRows(25);
  for (const diagnosis of diagnoses) {
    await store.increment("Practitioner/guard", "finding", diagnosis.stableKey, "now");
  }
  await store.replacePinned("Practitioner/guard", [], "now");
  const result = await handleDiagnosisQuickListRequest({ ...quickListDeps(fhir), diagnosisCatalog: async () => diagnoses }, { authHeader: undefined });
  assert.equal((result.body as { diagnoses: unknown[] }).diagnoses.length, 20);
});

test("G2 first pick receives all starter pins in order and preserves usage", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.increment("Practitioner/guard", "finding", "presbyopia", "now");
  const result = await handleDiagnosisQuickListRequest(quickListDeps(fhir), { authHeader: undefined });
  const body = result.body as { pinnedDiagnosisKeys: string[]; diagnoses: Array<{ stableKey: string; tallyCount: number }> };
  assert.deepEqual(body.pinnedDiagnosisKeys, STARTER_DIAGNOSIS_KEYS);
  assert.deepEqual(body.diagnoses.map((row) => row.stableKey), [...STARTER_DIAGNOSIS_KEYS, "presbyopia"]);
  assert.equal(body.diagnoses.at(-1)?.tallyCount, 1);
  assert.deepEqual((await store.read("Practitioner/guard"))?.counts, { finding: { presbyopia: 1 } });
});

test("G3 pre-pin storage receives starter and preserves usage", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.increment("Practitioner/guard", "finding", "presbyopia", "now");
  legacyTallyFormat(fhir, true);
  const result = await handleDiagnosisQuickListRequest(quickListDeps(fhir), { authHeader: undefined });
  assert.deepEqual((result.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys, STARTER_DIAGNOSIS_KEYS);
  assert.deepEqual((await store.read("Practitioner/guard"))?.counts, { finding: { presbyopia: 1 } });
});

test("G4 saved empty pins survive repeated reads and later picks", async () => {
  const fhir = new MemoryFhir();
  const deps = quickListDeps(fhir);
  const saved = await handleDiagnosisQuickListMutationRequest(deps, { authHeader: undefined, body: { pinnedDiagnosisKeys: [] } });
  assert.equal(saved.status, 200);
  await new FhirDiagnosisPickTallyStore(fhir).increment("Practitioner/guard", "finding", "presbyopia", "now");
  const before = fhir.writeCalls;
  for (let i = 0; i < 3; i++) {
    const result = await handleDiagnosisQuickListRequest(deps, { authHeader: undefined });
    assert.deepEqual((result.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys, []);
  }
  assert.equal(fhir.writeCalls, before);
});

test("G5 doctor pins remain unchanged in doctor order", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.replacePinned("Practitioner/guard", ["presbyopia", "myopia"], "now");
  for (let i = 0; i < 2; i++) {
    const result = await handleDiagnosisQuickListRequest(quickListDeps(fhir), { authHeader: undefined });
    assert.deepEqual((result.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys, ["presbyopia", "myopia"]);
  }
});

test("G6 chart reader causes no seed write for missing or unset records", async () => {
  for (const existing of [false, true]) {
    const fhir = new MemoryFhir();
    if (existing) await new FhirDiagnosisPickTallyStore(fhir).increment("Practitioner/guard", "finding", "presbyopia", "now");
    const before = structuredClone(fhir.resources);
    const writes = fhir.writeCalls;
    const result = await handleDiagnosisQuickListRequest(quickListDeps(fhir, "admin"), { authHeader: undefined });
    assert.equal(result.status, 200);
    assert.equal(fhir.writeCalls, writes);
    assert.deepEqual(fhir.resources, before);
  }
});

test("G7 ambiguous legacy empty pins are preserved across reads and picks", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.increment("Practitioner/guard", "finding", "presbyopia", "now");
  legacyTallyFormat(fhir);
  for (let i = 0; i < 2; i++) {
    const result = await handleDiagnosisQuickListRequest(quickListDeps(fhir), { authHeader: undefined });
    assert.deepEqual((result.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys, []);
    await store.increment("Practitioner/guard", "finding", "presbyopia", "later");
  }
});

test("G8 operator dry run lists every ambiguous tally without writes", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.increment("Practitioner/one", "finding", "presbyopia", "now");
  await store.increment("Practitioner/two", "finding", "myopia", "now");
  legacyTallyFormat(fhir);
  const before = structuredClone(fhir.resources);
  const writes = fhir.writeCalls;
  const result = await reseedCommonDiagnosisPins(fhir, { now: "later" });
  assert.deepEqual(result.changes.map((row) => row.practitionerReference), ["Practitioner/one", "Practitioner/two"]);
  assert.ok(result.changes.every((row) => row.action === "would-seed"));
  assert.deepEqual(result.changes[0].pinnedDiagnosisKeys, STARTER_DIAGNOSIS_KEYS);
  assert.equal(fhir.writeCalls, writes);
  assert.deepEqual(fhir.resources, before);
});

test("G9 operator apply seeds only ambiguous empties and is idempotent", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.increment("Practitioner/ambiguous", "finding", "presbyopia", "now");
  await store.increment("Practitioner/ambiguous", "finding", "presbyopia", "now");
  await store.replacePinned("Practitioner/legacy-pins", ["presbyopia", "myopia"], "now");
  legacyTallyFormat(fhir);
  await store.replacePinned("Practitioner/custom-empty", [], "now");
  await store.initializePinnedIfAbsent("Practitioner/seeded", [], "now");
  await store.increment("Practitioner/unset", "finding", "myopia", "now");
  const untouched = structuredClone(fhir.resources.slice(1));
  const result = await reseedCommonDiagnosisPins(fhir, { apply: true, now: "later" });
  assert.deepEqual(result.changes.map((row) => row.practitionerReference), ["Practitioner/ambiguous"]);
  assert.equal(result.changes[0].action, "seeded");
  const row = await store.read("Practitioner/ambiguous");
  assert.deepEqual(row?.pinnedDiagnosisKeys, STARTER_DIAGNOSIS_KEYS);
  assert.deepEqual(row?.counts, { finding: { presbyopia: 2 } });
  assert.equal(row?.pinState, "seeded");
  assert.deepEqual(fhir.resources.slice(1), untouched);
  const writes = fhir.writeCalls;
  const again = await reseedCommonDiagnosisPins(fhir, { apply: true, now: "later-again" });
  assert.deepEqual(again.changes, []);
  assert.equal(fhir.writeCalls, writes);
});

test("starter retries preserve a concurrent doctor's empty save", async () => {
  class SaveRaceFhir extends MemoryFhir {
    raced = false;
    override async update<T extends Basic>(type: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
      if (!this.raced) {
        this.raced = true;
        await new FhirDiagnosisPickTallyStore(this).replacePinned("Practitioner/guard", [], "doctor-save");
        assert.ok(headers?.["If-Match"], "seed must be conditional");
        throw Object.assign(new Error("changed"), { status: 412 });
      }
      return super.update(type, id, resource);
    }
  }
  const fhir = new SaveRaceFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.increment("Practitioner/guard", "finding", "presbyopia", "now");
  const result = await handleDiagnosisQuickListRequest(quickListDeps(fhir), { authHeader: undefined });
  assert.deepEqual((result.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys, []);
  assert.equal((await store.read("Practitioner/guard"))?.pinState, "custom");
  assert.deepEqual((await store.read("Practitioner/guard"))?.counts, { finding: { presbyopia: 1 } });
});

test("operator refuses a concurrent pin edit instead of overwriting it", async () => {
  class SaveRaceFhir extends MemoryFhir {
    raced = false;
    override async update<T extends Basic>(type: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
      if (!this.raced) {
        this.raced = true;
        await new FhirDiagnosisPickTallyStore(this).replacePinned("Practitioner/guard", [], "doctor-save");
        assert.ok(headers?.["If-Match"], "script must be conditional");
        throw Object.assign(new Error("changed"), { status: 412 });
      }
      return super.update(type, id, resource);
    }
  }
  const fhir = new SaveRaceFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.increment("Practitioner/guard", "finding", "presbyopia", "now");
  legacyTallyFormat(fhir);
  const result = await reseedCommonDiagnosisPins(fhir, { apply: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.changes, []);
  assert.deepEqual((await store.read("Practitioner/guard"))?.pinnedDiagnosisKeys, []);
  assert.equal((await store.read("Practitioner/guard"))?.pinState, "custom");
});

test("invalid persisted pin states are rejected instead of treated as unset", async () => {
  const fhir = new MemoryFhir();
  await new FhirDiagnosisPickTallyStore(fhir).increment("Practitioner/guard", "finding", "presbyopia", "now");
  const resource = fhir.resources[0] as Basic;
  const original = JSON.parse(resource.extension![0].valueString!);
  for (const pinState of [null, ["custom"], "unknown"]) {
    resource.extension![0].valueString = JSON.stringify({ ...original, pinState });
    assert.throws(() => parseDiagnosisPickTallyResource(resource), /pin state is invalid/);
  }
});

test("empty save records custom intent when a first pick wins conditional create", async () => {
  class PickRaceFhir extends MemoryFhir {
    raced = false;
    override async create<T extends Basic>(resource: T): Promise<T> {
      if (!this.raced) {
        this.raced = true;
        await new FhirDiagnosisPickTallyStore(this).increment("Practitioner/guard", "finding", "presbyopia", "pick");
        return structuredClone(this.resources[0]) as T;
      }
      return super.create(resource);
    }
  }
  const fhir = new PickRaceFhir();
  const store = new FhirDiagnosisPickTallyStore(fhir);
  await store.replacePinned("Practitioner/guard", [], "save");
  const result = await handleDiagnosisQuickListRequest(quickListDeps(fhir), { authHeader: undefined });
  assert.deepEqual((result.body as { pinnedDiagnosisKeys: string[] }).pinnedDiagnosisKeys, []);
  assert.equal((await store.read("Practitioner/guard"))?.pinState, "custom");
  assert.deepEqual((await store.read("Practitioner/guard"))?.counts, { finding: { presbyopia: 1 } });
});
