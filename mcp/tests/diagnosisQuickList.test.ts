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
      ? { staffReference, actorRole: "clinician" as const, fhir }
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
    [],
  );
  assert.deepEqual(otherBody.diagnoses, []);
  assert.deepEqual(
    otherBody.catalog.map((row) => row.stableKey),
    diagnoses
      .filter((row) => row.active && row.codingStatus === "verified")
      .map((row) => row.stableKey),
  );

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
