import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic } from "@medplum/fhirtypes";
import {
  createSingletonConfigDraft,
  singletonListAdapter,
  type CatalogCapabilities,
} from "../src/lib/catalog-adapter";

type FixtureItem = {
  id: string;
  label: string;
  active: boolean;
  refCount?: number;
};

const CAPABILITIES: CatalogCapabilities = {
  reorder: true,
  deactivate: true,
  presetSeed: false,
};

test("singletonListAdapter round-trips list, save, deactivate, reorder, discard, and one singleton commit", async () => {
  const writes: Array<{ kind: "create" | "update"; resource: Basic; sourceTag: string }> = [];
  const existing: Basic = {
    resourceType: "Basic",
    id: "fixture-config",
    meta: { versionId: "7" },
    code: { text: "Fixture" },
  };
  const config: Record<string, unknown> = {
    catalogs: {
      stations: [
        { id: "check-in", label: "Check In", active: true },
        { id: "exam", label: "Exam", active: true, refCount: 3 },
      ] satisfies FixtureItem[],
      waits: [{ id: "pickup", label: "Pickup", active: true }] satisfies FixtureItem[],
    },
  };
  const draft = createSingletonConfigDraft({
    configKey: "fixture-config",
    config,
    resource: existing,
    sourceTag: "settings-kit-demo",
    buildResource: (next) => ({
      resourceType: "Basic",
      code: { text: "Fixture" },
      extension: [{ url: "urn:odos:test:fixture-config", valueString: JSON.stringify(next) }],
    }),
    fhirClient: {
      async create(resource, sourceTag) {
        writes.push({ kind: "create", resource, sourceTag });
        return { ...resource, id: "created" };
      },
      async update(resource, sourceTag) {
        writes.push({ kind: "update", resource, sourceTag });
        return { ...resource, meta: { versionId: "8" } };
      },
    },
  });
  const stations = singletonListAdapter<FixtureItem>("fixture-config", "catalogs.stations", {
    draft,
    capabilities: CAPABILITIES,
  });
  const waits = singletonListAdapter<FixtureItem>("fixture-config", "catalogs.waits", {
    draft,
    capabilities: { ...CAPABILITIES, reorder: false },
  });

  assert.deepEqual((await stations.list()).map((item) => item.id), ["check-in", "exam"]);
  await stations.save({ id: "optical", label: "Optical", active: true });
  await stations.deactivate((await stations.list())[0]);
  await stations.reorder?.(["optical", "exam", "check-in"]);
  await waits.save({ id: "consult", label: "Consult", active: true });
  assert.equal(draft.dirty, true);
  assert.deepEqual((await stations.list()).map((item) => [item.id, item.active]), [
    ["optical", true],
    ["exam", true],
    ["check-in", false],
  ]);
  assert.deepEqual((await waits.list()).map((item) => item.id), ["pickup", "consult"]);

  const saved = await draft.commit();
  assert.equal(saved.id, "fixture-config");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "update");
  assert.equal(writes[0].sourceTag, "settings-kit-demo");
  assert.equal(writes[0].resource.id, existing.id);
  assert.equal(writes[0].resource.meta?.versionId, existing.meta?.versionId);
  assert.equal(draft.dirty, false);

  await stations.save({ id: "lab", label: "Lab", active: true });
  draft.discard();
  assert.equal((await stations.list()).some((item) => item.id === "lab"), false);
});

test("singletonListAdapter refuses deletes by exposing deactivation only and guards reorder ids", async () => {
  const draft = createSingletonConfigDraft({
    configKey: "fixture-config",
    config: { items: [{ id: "one", label: "One", active: true }] } as Record<string, unknown>,
    sourceTag: "settings-kit-demo",
    buildResource: () => ({ resourceType: "Basic", code: { text: "Fixture" } }),
    fhirClient: {
      async create(resource) {
        return resource;
      },
      async update(resource) {
        return resource;
      },
    },
  });
  const adapter = singletonListAdapter<FixtureItem>("fixture-config", "items", {
    draft,
    capabilities: CAPABILITIES,
  });

  assert.equal("delete" in adapter, false);
  await assert.rejects(async () => adapter.reorder?.([]), /every catalog item exactly once/);
});
