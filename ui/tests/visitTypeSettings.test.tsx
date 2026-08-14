import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Basic, Bundle, HealthcareService, Resource } from "@medplum/fhirtypes";
import { createSingletonConfigDraft } from "../src/lib/catalog-adapter";
import {
  buildVisitType,
  visibleSchedulingVisitTypes,
  visitTypeCode,
  visitTypeDurationMinutes,
} from "../src/lib/scheduling";
import {
  createVisitTypeCategoryAdapter,
  createVisitTypeResourceAdapter,
  visitTypeCatalogItem,
} from "../src/lib/visit-type-settings";
import {
  buildVisitTypeConfigResource,
  type PersistedVisitTypeConfig,
} from "../src/lib/visit-type-config";
import {
  VisitTypeSettingsReady,
  type VisitTypeSettingsClient,
} from "../src/scenes/settings/VisitTypeSettings";

const CATEGORIES: PersistedVisitTypeConfig = {
  categories: [
    { id: "comprehensive", label: "Comprehensive", order: 0 },
    { id: "dry-eye", label: "Dry Eye", order: 1 },
    { id: "archived", label: "Archived", order: 2 },
  ],
};

function visitType(
  id: string,
  name: string,
  active: boolean,
  categoryCode?: string,
  categoryLabel?: string,
  durationMinutes = 30,
): HealthcareService {
  return {
    ...buildVisitType({
      code: id,
      name,
      discipline: "eyecare",
      durationMinutes,
      color: "#4a7dff",
      active,
      ...(categoryCode ? { categoryCode, categoryLabel } : {}),
    }),
    id,
    meta: { versionId: "7" },
  };
}

function resourceClient(pages: HealthcareService[][]) {
  const writes: Array<{ kind: "create" | "update"; resource: HealthcareService; sourceTag: string }> = [];
  let searchUrlCalls = 0;
  const client = {
    async search<T extends Resource>() {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: pages[0]?.map((resource) => ({ resource })) ?? [],
        ...(pages.length > 1 ? { link: [{ relation: "next", url: "https://example.test/page-2" }] } : {}),
      } as Bundle<T>;
    },
    async searchUrl<T extends Resource>() {
      searchUrlCalls += 1;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: pages[1]?.map((resource) => ({ resource })) ?? [],
      } as Bundle<T>;
    },
    async create<T extends Resource>(resource: T, sourceTag: string) {
      writes.push({ kind: "create", resource: resource as HealthcareService, sourceTag });
      return { ...resource, id: "created-visit-type", meta: { versionId: "1" } } as T;
    },
    async update<T extends Resource>(resource: T, sourceTag: string) {
      writes.push({ kind: "update", resource: resource as HealthcareService, sourceTag });
      return resource;
    },
  };
  return { client, writes, get searchUrlCalls() { return searchUrlCalls; } };
}

function emptyPracticeClient() {
  const resources: Resource[] = [];
  const client = {
    async search<T extends Resource>(resourceType: T["resourceType"]) {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: resources
          .filter((resource) => resource.resourceType === resourceType)
          .map((resource) => ({ resource })),
      } as Bundle<T>;
    },
    async searchUrl<T extends Resource>() {
      return { resourceType: "Bundle", type: "searchset", entry: [] } as Bundle<T>;
    },
    async create<T extends Resource>(resource: T) {
      const saved = { ...resource, id: `${resource.resourceType}-${resources.length + 1}` } as T;
      resources.push(saved);
      return saved;
    },
    async update<T extends Resource>(resource: T) {
      const index = resources.findIndex((candidate) =>
        candidate.resourceType === resource.resourceType && candidate.id === resource.id
      );
      if (index >= 0) resources[index] = resource;
      return resource;
    },
  };
  return { client, resources };
}

function button(renderer: ReactTestRenderer, label: string) {
  const match = renderer.root.findAllByType("button").find((candidate) =>
    candidate.children.join("") === label
  );
  assert.ok(match, `button ${label} exists`);
  return match;
}

test("resourceCatalogAdapter lists inactive visit types across every page and fails closed without pagination support", async () => {
  const active = visitType("active", "Active", true);
  const inactive = visitType("inactive", "Inactive", false);
  const fixture = resourceClient([[active], [inactive]]);
  const adapter = createVisitTypeResourceAdapter(fixture.client, () => []);
  const listed = await adapter.list();
  assert.deepEqual(listed.map((item) => [item.id, item.active]), [
    ["active", true],
    ["inactive", false],
  ]);
  assert.equal(fixture.searchUrlCalls, 1);

  const withoutPagination = { ...fixture.client, searchUrl: undefined };
  const guarded = createVisitTypeResourceAdapter(withoutPagination, () => []);
  await assert.rejects(() => guarded.list(), /client cannot fetch it/);
});

test("visit-type resource save preserves id/meta and immutable code while deactivate flips active only", async () => {
  const original = visitType("dry-eye-consult", "Dry Eye Consult", true, "dry-eye", "Dry Eye");
  const fixture = resourceClient([[original]]);
  const adapter = createVisitTypeResourceAdapter(fixture.client, () => [
    { id: "dry-eye", label: "Dry Eye", order: 0, active: true },
  ]);
  const item = visitTypeCatalogItem(original);
  const renamed = await adapter.save({
    ...item,
    code: "attempted-code-change",
    label: "Ocular Surface Consult",
  });
  assert.equal(renamed.id, original.id);
  assert.equal(renamed.code, "dry-eye-consult");
  assert.equal(fixture.writes[0]?.resource.id, original.id);
  assert.deepEqual(fixture.writes[0]?.resource.meta, original.meta);
  assert.equal(visitTypeCode(fixture.writes[0]!.resource), "dry-eye-consult");
  assert.equal(fixture.writes[0]?.sourceTag, "visit-type-catalog");

  await adapter.deactivate(item);
  assert.deepEqual(fixture.writes[1]?.resource, { ...original, active: false });
});

test("new visit-type codes are generated once from the label", async () => {
  const fixture = resourceClient([[]]);
  const adapter = createVisitTypeResourceAdapter(fixture.client, () => []);
  const created = await adapter.save(
    visitTypeCatalogItem({
      resourceType: "HealthcareService",
      name: "Myopia Control Consult",
      active: true,
      category: [],
      extension: [
        { url: "https://odos2020.com/fhir/StructureDefinition/odos-visit-duration", valuePositiveInt: 45 },
        { url: "https://odos2020.com/fhir/StructureDefinition/odos-display-color", valueString: "#cc88ff" },
      ],
    }),
  );
  assert.equal(created.code, "myopia-control-consult");
  assert.equal(visitTypeCode(fixture.writes[0]!.resource), "myopia-control-consult");
});

test("scheduler picker hygiene excludes deactivated visit types", () => {
  assert.deepEqual(
    visibleSchedulingVisitTypes(
      [visitType("active", "Active", true), visitType("inactive", "Inactive", false)],
      "eyecare",
    ).map((resource) => resource.id),
    ["active"],
  );
});

test("category edits dirty only the singleton draft and active-member deactivation is blocked with the count", async () => {
  const draft = createSingletonConfigDraft({
    configKey: "odos-visit-type-config",
    config: CATEGORIES,
    buildResource: buildVisitTypeConfigResource,
    sourceTag: "visit-type-config",
    fhirClient: {
      async create(resource) { return resource; },
      async update(resource) { return resource; },
    },
  });
  const assigned = visitType("assigned", "Assigned", true, "dry-eye", "Dry Eye");
  const adapter = createVisitTypeCategoryAdapter(draft, () => [assigned]);
  const dryEye = (await adapter.list()).find((category) => category.id === "dry-eye")!;
  await assert.rejects(
    () => adapter.save({ ...dryEye, active: false }),
    /Category "Dry Eye" cannot be deactivated because 1 active visit type is assigned/,
  );
  assert.equal(draft.dirty, false);
  const renamed = await adapter.save({
    ...dryEye,
    id: "attempted-id-change",
    label: "Ocular Surface",
  });
  assert.equal(renamed.id, "dry-eye");
  assert.equal(draft.dirty, true);
});

test("visit-type scene shows mixed save semantics, grouping, Uncategorized last, and code read-only", () => {
  const dryEye = visitType("dry-eye-consult", "Dry Eye Consult", true, "dry-eye", "Dry Eye");
  const uncategorized = visitType("walk-in", "Walk In", true);
  const archived = visitType("old", "Old Visit", false, "archived", "Archived");
  const fixture = resourceClient([[dryEye, uncategorized, archived]]);
  const html = renderToStaticMarkup(
    <VisitTypeSettingsReady
      config={CATEGORIES}
      canWrite
      client={fixture.client as VisitTypeSettingsClient}
      initialVisitTypes={[dryEye, uncategorized, archived]}
      initialSelectedCategoryId="dry-eye"
      initialSelectedVisitTypeId="dry-eye-consult"
    />,
  );
  assert.match(html, /Categories/);
  assert.match(html, /Visit types/);
  assert.match(html, /Apply to draft/);
  assert.match(html, />Save</);
  assert.match(html, /Code/);
  assert.match(html, /dry-eye-consult/);
  assert.ok(html.indexOf("Dry Eye") < html.indexOf("Uncategorized"));
  assert.match(html, /Inactive · expand/);
  assert.doesNotMatch(html, /Old Visit/);
});

test("visit-type duration select offers only 60, 45, 30, 20, 15, and 10 minutes and defaults new items to 30", async () => {
  const fixture = resourceClient([[]]);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VisitTypeSettingsReady
        config={CATEGORIES}
        canWrite
        client={fixture.client as VisitTypeSettingsClient}
        initialVisitTypes={[]}
      />,
    );
  });

  act(() => button(renderer, "+ Add visit type").props.onClick());
  const duration = renderer.root.findAllByType("select").find((candidate) =>
    candidate.findAllByType("option").some((option) => option.props.value === "60")
  );
  assert.ok(duration, "duration renders as a select");
  assert.deepEqual(
    duration.findAllByType("option").map((option) => option.props.value).filter(Boolean),
    ["60", "45", "30", "20", "15", "10"],
  );
  assert.equal(duration.props.value, "30");

  const label = renderer.root.findAllByType("input").find((candidate) =>
    candidate.props.value === ""
  );
  assert.ok(label, "new visit type label is editable");
  act(() => label.props.onChange({ target: { value: "New Visit" } }));
  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(visitTypeDurationMinutes(fixture.writes[0]!.resource), 30);
  act(() => renderer.unmount());
});

test("label-only edits preserve an out-of-list legacy duration until a listed duration is chosen", async () => {
  const legacy = visitType("legacy", "Legacy Visit", true, undefined, undefined, 28);
  const fixture = resourceClient([[legacy]]);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VisitTypeSettingsReady
        config={CATEGORIES}
        canWrite
        client={fixture.client as VisitTypeSettingsClient}
        initialVisitTypes={[legacy]}
        initialSelectedVisitTypeId="legacy"
      />,
    );
  });

  const duration = renderer.root.findAllByType("select").find((candidate) =>
    candidate.findAllByType("option").some((option) => option.props.value === "60")
  );
  assert.ok(duration, "legacy duration still renders the constrained select");
  assert.equal(duration.props.value, "");
  assert.match(JSON.stringify(renderer.toJSON()), /Current custom duration.*28 min/);

  const label = renderer.root.findAllByType("input").find((candidate) =>
    candidate.props.value === "Legacy Visit"
  );
  assert.ok(label, "legacy visit label is editable");
  act(() => label.props.onChange({ target: { value: "Renamed Legacy Visit" } }));
  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0]?.resource.name, "Renamed Legacy Visit");
  assert.equal(visitTypeDurationMinutes(fixture.writes[0]!.resource), 28);
  act(() => renderer.unmount());
});

test("visit-type scene offers both starter seeds when empty and removes all editor affordances in read-only mode", () => {
  const fixture = resourceClient([[]]);
  const empty = renderToStaticMarkup(
    <VisitTypeSettingsReady
      config={{ categories: [] }}
      canWrite
      client={fixture.client as VisitTypeSettingsClient}
      initialVisitTypes={[]}
    />,
  );
  assert.match(empty, /Use starter categories/);
  assert.match(empty, /Use starter visit types/);

  const readOnly = renderToStaticMarkup(
    <VisitTypeSettingsReady
      config={CATEGORIES}
      canWrite={false}
      client={fixture.client as VisitTypeSettingsClient}
      initialVisitTypes={[visitType("routine", "Routine Exam", true)]}
    />,
  );
  assert.match(readOnly, /Routine Exam/);
  assert.doesNotMatch(readOnly, /\+ Add category|\+ Add visit type|role="dialog"/);
});

test("the existing starter controls persist categories and visit types for an empty practice", async () => {
  const fixture = emptyPracticeClient();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VisitTypeSettingsReady
        config={{ categories: [] }}
        canWrite
        client={fixture.client as VisitTypeSettingsClient}
      />,
    );
    await new Promise((resolve) => setImmediate(resolve));
  });

  await act(async () => {
    button(renderer, "Use starter categories").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    button(renderer, "Use starter visit types").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });

  const categoryConfigs = fixture.resources.filter((resource) => resource.resourceType === "Basic") as Basic[];
  const visitTypes = fixture.resources.filter(
    (resource) => resource.resourceType === "HealthcareService",
  ) as HealthcareService[];
  assert.deepEqual(
    categoryConfigs.flatMap((resource) =>
      JSON.parse(resource.extension?.[0]?.valueString ?? "{}").categories?.map(
        (category: { id: string }) => category.id,
      ) ?? []
    ),
    ["comprehensive", "dry-eye", "myopia-management", "diagnostic-only"],
  );
  assert.equal(visitTypes.length, 10);
  assert.equal(new Set(visitTypes.map(visitTypeCode)).size, 10);
  act(() => renderer.unmount());
});
