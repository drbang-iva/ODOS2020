import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import {
  handleDiagnosisQuickListMutationRequest,
  handleDiagnosisQuickListRequest,
  orderDiagnosisQuickList,
} from "../src/clinical-graph/diagnosis-quick-list-endpoint.js";
import {
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

test("quick-list preserves every pin in doctor-selected order beyond the Common cap", () => {
  const diagnoses = diagnosisRows(20);
  const pinnedDiagnosisKeys = diagnoses.slice(0, 17).map((row) => row.stableKey).reverse();
  const ordered = orderDiagnosisQuickList(diagnoses, {
    counts: {},
    pinnedDiagnosisKeys,
    updatedAt: "2026-08-10T12:00:00.000Z",
  });

  assert.deepEqual(ordered.map((row) => row.stableKey), pinnedDiagnosisKeys);
});

test("quick-list fills positive usage in descending order only to 15 total rows", () => {
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
  assert.deepEqual(body.diagnoses.map((row) => [row.stableKey, row.display, row.axisLabel]), [
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
  readonly resources: Resource[] = [];

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
    const persisted = {
      ...resource,
      id,
      meta: { versionId, lastUpdated: "2026-08-09T12:01:00.000Z" },
    } as T;
    this.resources[index] = persisted;
    return structuredClone(persisted);
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
