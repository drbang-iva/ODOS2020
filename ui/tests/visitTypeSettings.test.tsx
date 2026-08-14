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
  createStagedVisitTypeAdapter,
  visitTypeCatalogItem,
} from "../src/lib/visit-type-settings";
import {
  buildVisitTypeConfigResource,
  type PersistedVisitTypeConfig,
} from "../src/lib/visit-type-config";
import {
  VisitTypeSettingsReady,
  createVisitTypeSettingsTransaction,
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
  let searchCalls = 0;
  let searchUrlCalls = 0;
  const client = {
    async search<T extends Resource>() {
      searchCalls += 1;
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
  return {
    client,
    writes,
    get searchCalls() { return searchCalls; },
    get searchUrlCalls() { return searchUrlCalls; },
  };
}

function emptyPracticeClient({
  failAfterPersistingVisitTypeCreate,
  failCategoryCreate = false,
  failFirstRecoverySearch = false,
  failFirstVisitTypeUpdateAfterPersist = false,
  initialResources = [],
}: {
  failAfterPersistingVisitTypeCreate?: number;
  failCategoryCreate?: boolean;
  failFirstRecoverySearch?: boolean;
  failFirstVisitTypeUpdateAfterPersist?: boolean;
  initialResources?: Resource[];
} = {}) {
  const resources: Resource[] = structuredClone(initialResources);
  const successfulVisitTypeCreateCodes: string[] = [];
  const writeOrder: string[] = [];
  let visitTypeCreateCount = 0;
  let failurePending = failAfterPersistingVisitTypeCreate !== undefined;
  let recoverySearchFailurePending = failFirstRecoverySearch;
  let visitTypeUpdateFailurePending = failFirstVisitTypeUpdateAfterPersist;
  let forcedHealthcareServiceSearchFailures = 0;
  const client = {
    async search<T extends Resource>(resourceType: T["resourceType"]) {
      if (resourceType === "HealthcareService" && forcedHealthcareServiceSearchFailures > 0) {
        forcedHealthcareServiceSearchFailures -= 1;
        throw new Error("authoritative visit type read unavailable");
      }
      if (resourceType === "HealthcareService" && resources.length > 0 && recoverySearchFailurePending) {
        recoverySearchFailurePending = false;
        throw new Error("recovery read unavailable");
      }
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
      if (failCategoryCreate && resource.resourceType === "Basic") {
        throw new Error("category write denied");
      }
      const saved = { ...resource, id: `${resource.resourceType}-${resources.length + 1}` } as T;
      resources.push(saved);
      writeOrder.push(saved.resourceType === "Basic"
        ? "category"
        : `visit:${visitTypeCode(saved as HealthcareService)}:${(saved as HealthcareService).active !== false}`);
      if (saved.resourceType === "HealthcareService") {
        visitTypeCreateCount += 1;
        successfulVisitTypeCreateCodes.push(visitTypeCode(saved));
        if (failurePending && visitTypeCreateCount === failAfterPersistingVisitTypeCreate) {
          failurePending = false;
          throw new Error("connection dropped after the server applied this visit type");
        }
      }
      return saved;
    },
    async update<T extends Resource>(resource: T) {
      const index = resources.findIndex((candidate) =>
        candidate.resourceType === resource.resourceType && candidate.id === resource.id
      );
      if (index >= 0) resources[index] = resource;
      writeOrder.push(resource.resourceType === "Basic"
        ? "category"
        : `visit:${visitTypeCode(resource as HealthcareService)}:${(resource as HealthcareService).active !== false}`);
      if (resource.resourceType === "HealthcareService" && visitTypeUpdateFailurePending) {
        visitTypeUpdateFailurePending = false;
        throw new Error("connection dropped after the server applied this visit type");
      }
      return resource;
    },
  };
  return {
    client,
    resources,
    successfulVisitTypeCreateCodes,
    writeOrder,
    failNextHealthcareServiceSearch() { forcedHealthcareServiceSearchFailures += 1; },
  };
}

function button(renderer: ReactTestRenderer, label: string) {
  const match = renderer.root.findAllByType("button").find((candidate) =>
    candidate.children.join("") === label
  );
  assert.ok(match, `button ${label} exists`);
  return match;
}

function renderedText(node: ReactTestRenderer["root"] | ReturnType<ReactTestRenderer["root"]["findByType"]> | string): string {
  if (typeof node === "string") return node;
  return node.children.map((child) =>
    typeof child === "string" ? child : renderedText(child)
  ).join("");
}

async function stageDryEyeDeactivation(renderer: ReactTestRenderer) {
  await act(async () => {
    button(renderer, "Deactivate").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  const categoryRow = renderer.root.findAllByType("button").find((candidate) => {
    const text = renderedText(candidate);
    return text.includes("Dry Eye") && text.includes("dry-eye");
  });
  assert.ok(categoryRow, "Dry Eye category row exists");
  act(() => categoryRow.props.onClick());
  await act(async () => {
    button(renderer, "Deactivate").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
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

test("visit-type scene shows unified draft semantics, grouping, Uncategorized last, and code read-only", () => {
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
  assert.equal(html.match(/Apply to draft/g)?.length, 2);
  assert.doesNotMatch(html, />Save</);
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
    button(renderer, "Apply to draft").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(fixture.writes.length, 0);
  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(visitTypeDurationMinutes(fixture.writes[0]!.resource), 30);
  act(() => renderer.unmount());
});

test("an out-of-list legacy duration renders read-only and blocks persistence until a listed duration is chosen", async () => {
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
    button(renderer, "Apply to draft").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.equal(fixture.writes.length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /Duration \(minutes\) is required/);

  await act(async () => {
    button(renderer, "Deactivate").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(fixture.writes.length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /Choose a listed duration before changing this 28-minute visit type/);

  act(() => duration.props.onChange({ target: { value: "45" } }));
  await act(async () => {
    button(renderer, "Apply to draft").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.equal(fixture.writes.length, 0);
  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0]?.resource.name, "Renamed Legacy Visit");
  assert.equal(visitTypeDurationMinutes(fixture.writes[0]!.resource), 45);
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

test("both starter controls stage with zero writes and Save preserves the existing end state", async () => {
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
    button(renderer, "Use starter visit types").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(fixture.resources.length, 0, "neither starter writes before the shared Save");
  await act(async () => {
    button(renderer, "Save").props.onClick();
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

test("a failed starter commit reports the exact boundary and retry creates each visit type exactly once", async () => {
  const fixture = emptyPracticeClient({ failAfterPersistingVisitTypeCreate: 3 });
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
    await new Promise((resolve) => setImmediate(resolve));
  });

  await act(async () => {
    button(renderer, "Use starter visit types").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(fixture.successfulVisitTypeCreateCodes.length, 0);

  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(fixture.successfulVisitTypeCreateCodes.length, 3);
  assert.match(
    JSON.stringify(renderer.toJSON()),
    /Visit type save failed after 3 of 10 changes were applied.*7 changes were not attempted.*Re-run Save/,
  );

  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.equal(fixture.successfulVisitTypeCreateCodes.length, 10);
  assert.equal(new Set(fixture.successfulVisitTypeCreateCodes).size, 10);
  assert.equal(
    fixture.resources.filter((resource) => resource.resourceType === "HealthcareService").length,
    10,
  );
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Unsaved settings changes/);
  act(() => renderer.unmount());
});

test("retry reconciles an unknown create outcome before issuing another starter write", async () => {
  const fixture = emptyPracticeClient({
    failAfterPersistingVisitTypeCreate: 3,
    failFirstRecoverySearch: true,
  });
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
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    button(renderer, "Use starter visit types").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(JSON.stringify(renderer.toJSON()), /could not be verified; reload before retrying/);

  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(fixture.successfulVisitTypeCreateCodes.length, 10);
  assert.equal(new Set(fixture.successfulVisitTypeCreateCodes).size, 10);
  assert.equal(
    fixture.resources.filter((resource) => resource.resourceType === "HealthcareService").length,
    10,
  );
  act(() => renderer.unmount());
});

test("category and visit-type failures identify which write group was applied", async () => {
  const visitFailure = emptyPracticeClient({ failAfterPersistingVisitTypeCreate: 3 });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VisitTypeSettingsReady
        config={{ categories: [] }}
        canWrite
        client={visitFailure.client as VisitTypeSettingsClient}
        initialVisitTypes={[]}
      />,
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    button(renderer, "Use starter categories").props.onClick();
    button(renderer, "Use starter visit types").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(
    JSON.stringify(renderer.toJSON()),
    /Category settings saved.*Visit type save failed after 3 of 10 changes were applied/,
  );
  assert.equal(
    visitFailure.resources.filter((resource) => resource.resourceType === "Basic").length,
    1,
  );
  act(() => renderer.unmount());

  const categoryFailure = emptyPracticeClient({ failCategoryCreate: true });
  await act(async () => {
    renderer = create(
      <VisitTypeSettingsReady
        config={{ categories: [] }}
        canWrite
        client={categoryFailure.client as VisitTypeSettingsClient}
        initialVisitTypes={[]}
      />,
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    button(renderer, "Use starter categories").props.onClick();
    button(renderer, "Use starter visit types").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(
    JSON.stringify(renderer.toJSON()),
    /Category settings were not saved.*Visit type changes were not attempted.*category write denied/,
  );
  assert.equal(categoryFailure.successfulVisitTypeCreateCodes.length, 0);
  act(() => renderer.unmount());
});

test("Discard clears staged categories and visit types together", async () => {
  const fixture = emptyPracticeClient();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VisitTypeSettingsReady
        config={{ categories: [] }}
        canWrite
        client={fixture.client as VisitTypeSettingsClient}
        initialVisitTypes={[]}
      />,
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    button(renderer, "Use starter categories").props.onClick();
    button(renderer, "Use starter visit types").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(JSON.stringify(renderer.toJSON()), /Unsaved settings changes/);
  await act(async () => {
    button(renderer, "Discard").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(fixture.resources.length, 0);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Unsaved settings changes/);
  assert.match(JSON.stringify(renderer.toJSON()), /Use starter categories/);
  assert.match(JSON.stringify(renderer.toJSON()), /Use starter visit types/);
  act(() => renderer.unmount());
});

test("a successful staged commit clears dirty from write responses without a server re-read", async () => {
  const fixture = resourceClient([[]]);
  const base = createVisitTypeResourceAdapter(fixture.client, () => []);
  const staged = createStagedVisitTypeAdapter(base, []);
  await staged.save(visitTypeCatalogItem(buildVisitType({
    code: "routine",
    name: "Routine Exam",
    discipline: "eyecare",
    durationMinutes: 30,
    color: "#4a7dff",
    active: true,
  })));
  assert.equal(staged.dirty, true);
  await staged.commit();
  assert.equal(staged.dirty, false);
  assert.equal(fixture.searchCalls, 0);
  assert.equal(fixture.searchUrlCalls, 0);
  assert.equal(fixture.writes.length, 1);
});

test("staged visit-type deactivation renders inactive immediately without a write and Discard restores it", async () => {
  const routine = visitType("routine", "Routine Exam", true);
  const fixture = resourceClient([[routine]]);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VisitTypeSettingsReady
        config={CATEGORIES}
        canWrite
        client={fixture.client as VisitTypeSettingsClient}
        initialVisitTypes={[routine]}
      />,
    );
    await new Promise((resolve) => setImmediate(resolve));
  });

  const routineRow = renderer.root.findAllByType("button").find((candidate) =>
    renderedText(candidate).includes("Routine Exam")
  );
  assert.ok(routineRow);
  act(() => routineRow.props.onClick());
  await act(async () => {
    button(renderer, "Deactivate").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.equal(fixture.writes.length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /Inactive · expand/);
  const expand = renderer.root.findAllByType("button").find((candidate) =>
    renderedText(candidate).includes("Inactive · expand")
  );
  assert.ok(expand);
  act(() => expand.props.onClick());
  assert.match(JSON.stringify(renderer.toJSON()), /Routine Exam.*Inactive/);

  await act(async () => {
    button(renderer, "Discard").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(fixture.writes.length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /Routine Exam.*Active/);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Unsaved settings changes/);
  act(() => renderer.unmount());
});

test("mixed activation and deactivation commits dependent visit types before categories and remaining visit types after", async () => {
  const config: PersistedVisitTypeConfig = {
    categories: [
      { id: "activate-a", label: "Activate A", order: 0, active: false },
      { id: "deactivate-b", label: "Deactivate B", order: 1 },
    ],
  };
  const nextConfig: PersistedVisitTypeConfig = {
    categories: [
      { id: "activate-a", label: "Activate A", order: 0 },
      { id: "deactivate-b", label: "Deactivate B", order: 1, active: false },
    ],
  };
  const categoryResource = { ...buildVisitTypeConfigResource(config), id: "visit-config" };
  const visitA = visitType("visit-a", "Visit A", false, "activate-a", "Activate A");
  const visitB = visitType("visit-b", "Visit B", true, "deactivate-b", "Deactivate B");
  const fixture = emptyPracticeClient({ initialResources: [categoryResource, visitA, visitB] });
  const categoryDraft = createSingletonConfigDraft({
    configKey: "odos-visit-type-config",
    config,
    resource: categoryResource,
    buildResource: buildVisitTypeConfigResource,
    sourceTag: "visit-type-config",
    fhirClient: fixture.client,
  });
  const resourceAdapter = createVisitTypeResourceAdapter(
    fixture.client,
    () => nextConfig.categories.map((category) => ({ ...category, active: category.active !== false })),
  );
  const visitDraft = createStagedVisitTypeAdapter(
    resourceAdapter,
    [visitTypeCatalogItem(visitA), visitTypeCatalogItem(visitB)],
  );
  categoryDraft.replace(nextConfig);
  await visitDraft.deactivate(visitTypeCatalogItem(visitB));
  await visitDraft.save({ ...visitTypeCatalogItem(visitA), active: true });

  await createVisitTypeSettingsTransaction(categoryDraft, visitDraft).commit();

  assert.deepEqual(fixture.writeOrder, [
    "visit:visit-b:false",
    "category",
    "visit:visit-a:true",
  ]);
});

test("partial deactivation failure never persists an inactive category with an active assigned visit type, and Discard reloads landed server state", async () => {
  const categoryResource = { ...buildVisitTypeConfigResource(CATEGORIES), id: "visit-config" };
  const assigned = visitType("assigned", "Assigned Visit", true, "dry-eye", "Dry Eye");
  const fixture = emptyPracticeClient({
    initialResources: [categoryResource, assigned],
    failFirstVisitTypeUpdateAfterPersist: true,
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VisitTypeSettingsReady
        config={CATEGORIES}
        configResource={categoryResource}
        canWrite
        client={fixture.client as VisitTypeSettingsClient}
        initialVisitTypes={[assigned]}
        initialSelectedVisitTypeId="assigned"
      />,
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  await stageDryEyeDeactivation(renderer);
  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });

  const serverCategory = fixture.resources.find((resource) => resource.resourceType === "Basic") as Basic;
  const serverVisit = fixture.resources.find((resource) => resource.resourceType === "HealthcareService") as HealthcareService;
  const serverConfig = JSON.parse(serverCategory.extension?.[0]?.valueString ?? "{}");
  const inactiveCategoryIds = new Set(
    serverConfig.categories.filter((category: { active?: boolean }) => category.active === false)
      .map((category: { id: string }) => category.id),
  );
  assert.equal(
    serverVisit.active !== false && inactiveCategoryIds.has("dry-eye"),
    false,
    "the induced failure cannot leave an active visit type referencing an inactive category",
  );
  assert.deepEqual(fixture.writeOrder, ["visit:assigned:false"]);
  assert.match(JSON.stringify(renderer.toJSON()), /Unsaved settings changes/);

  await act(async () => {
    button(renderer, "Discard").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /changes applied before the failure remain saved/i);
  assert.match(rendered, /Inactive · expand/);
  assert.doesNotMatch(rendered, /Unsaved settings changes/);
  act(() => renderer.unmount());
});

test("failed authoritative Discard after a partial save reports the read failure and remains dirty", async () => {
  const categoryResource = { ...buildVisitTypeConfigResource(CATEGORIES), id: "visit-config" };
  const assigned = visitType("assigned", "Assigned Visit", true, "dry-eye", "Dry Eye");
  const fixture = emptyPracticeClient({
    initialResources: [categoryResource, assigned],
    failFirstVisitTypeUpdateAfterPersist: true,
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VisitTypeSettingsReady
        config={CATEGORIES}
        configResource={categoryResource}
        canWrite
        client={fixture.client as VisitTypeSettingsClient}
        initialVisitTypes={[assigned]}
        initialSelectedVisitTypeId="assigned"
      />,
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  await stageDryEyeDeactivation(renderer);
  await act(async () => {
    button(renderer, "Save").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  fixture.failNextHealthcareServiceSearch();
  await act(async () => {
    button(renderer, "Discard").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });

  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /Could not discard practice settings/);
  assert.match(rendered, /authoritative visit type read unavailable/);
  assert.match(rendered, /Unsaved settings changes/);
  act(() => renderer.unmount());
});

test("deactivating an edited visit type commits the full staged draft instead of the original fields", async () => {
  const original = visitType("routine", "Routine Exam", true, "comprehensive", "Comprehensive");
  const fixture = resourceClient([[original]]);
  const staged = createStagedVisitTypeAdapter(
    createVisitTypeResourceAdapter(fixture.client, () => [
      { id: "comprehensive", label: "Comprehensive", order: 0, active: true },
    ]),
    [visitTypeCatalogItem(original)],
  );
  const edited = { ...visitTypeCatalogItem(original), label: "Edited Routine", durationMinutes: 45 };
  await staged.save(edited);
  await staged.deactivate(edited);
  await staged.commit();

  assert.equal(fixture.writes[0]?.resource.name, "Edited Routine");
  assert.equal(visitTypeDurationMinutes(fixture.writes[0]!.resource), 45);
  assert.equal(fixture.writes[0]?.resource.active, false);
});
