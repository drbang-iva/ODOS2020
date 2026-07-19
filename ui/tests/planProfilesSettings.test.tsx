import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  planProfileAdapter,
  type PlanProfileItem,
} from "../src/lib/plan-profile-catalog";
import {
  PlanProfilesSettings,
  planProfileDescriptor,
} from "../src/scenes/settings/PlanProfilesSettings";
import { CatalogSection } from "../src/scenes/settings/CatalogEditor";

const COMPLETE: PlanProfileItem = {
  id: "vsp-choice",
  planKey: "payer:VSP:choice",
  displayName: "VSP Choice",
  dispensingFeeCents: 1800,
  frameAllowanceCents: 15000,
  lensBaseReimbursementCents: 4200,
  contactLensPerBoxCents: 2800,
  active: true,
};

test("plan-profile adapter round-trips every field and keeps missing money absent", async () => {
  const fixture = resourceClient([]);
  const adapter = planProfileAdapter(fixture.client);
  const complete = await adapter.save(COMPLETE);
  assert.deepEqual(
    {
      planKey: complete.planKey,
      displayName: complete.displayName,
      dispensingFeeCents: complete.dispensingFeeCents,
      frameAllowanceCents: complete.frameAllowanceCents,
      lensBaseReimbursementCents: complete.lensBaseReimbursementCents,
      contactLensPerBoxCents: complete.contactLensPerBoxCents,
      active: complete.active,
    },
    {
      planKey: COMPLETE.planKey,
      displayName: COMPLETE.displayName,
      dispensingFeeCents: COMPLETE.dispensingFeeCents,
      frameAllowanceCents: COMPLETE.frameAllowanceCents,
      lensBaseReimbursementCents: COMPLETE.lensBaseReimbursementCents,
      contactLensPerBoxCents: COMPLETE.contactLensPerBoxCents,
      active: COMPLETE.active,
    },
  );

  const partial = await adapter.save({
    id: "eyemed",
    planKey: "payer:EyeMed",
    displayName: "EyeMed",
    active: true,
  });
  assert.equal(partial.displayName, "EyeMed");
  for (const field of [
    "dispensingFeeCents",
    "frameAllowanceCents",
    "lensBaseReimbursementCents",
    "contactLensPerBoxCents",
  ] as const) {
    assert.equal(Object.hasOwn(partial, field), false, field);
  }
  assert.equal(
    fixture.resources[1]?.extension?.[0]?.extension?.some(
      (extension) => extension.valueMoney?.value === 0,
    ),
    false,
  );
});

test("plan-profile adapter rejects fractional and negative cents", async () => {
  const adapter = planProfileAdapter(resourceClient([]).client);
  await assert.rejects(
    () => adapter.save({ ...COMPLETE, dispensingFeeCents: 250.5 }),
    /whole number of cents/,
  );
  await assert.rejects(
    () => adapter.save({ ...COMPLETE, frameAllowanceCents: -1 }),
    /whole number of cents/,
  );
  const persisted = {
    ...COMPLETE,
    resource: {
      ...buildResource(COMPLETE),
      id: "basic-1",
    },
  };
  await assert.rejects(
    () => adapter.save({ ...persisted, planKey: "payer:changed" }),
    /cannot change after the profile is created/,
  );
});

test("deactivation persists the row, removes it from active results, and reactivation works", async () => {
  const fixture = resourceClient([]);
  const adapter = planProfileAdapter(fixture.client);
  const saved = await adapter.save(COMPLETE);
  const deactivated = await adapter.deactivate(saved);
  assert.equal(deactivated.active, false);
  assert.equal(fixture.resources.length, 1);
  assert.deepEqual((await adapter.list()).filter((row) => row.active), []);

  const reactivated = await adapter.save({ ...deactivated, active: true });
  assert.equal(reactivated.active, true);
  assert.deepEqual((await adapter.list()).filter((row) => row.active).map((row) => row.planKey), [
    COMPLETE.planKey,
  ]);
});

test("plan-profile descriptor inherits required-gate, list-header, and confirm-deactivate grammar", async () => {
  const adapter = planProfileAdapter(resourceClient([]).client);
  const descriptor = planProfileDescriptor(adapter);
  const draft: PlanProfileItem = {
    id: "new-plan",
    planKey: "",
    displayName: "",
    active: true,
  };
  const blocked = renderToStaticMarkup(
    <CatalogSection
      descriptor={descriptor}
      canWrite
      initialState={{ items: [draft], selectedId: draft.id }}
    />,
  );
  assert.match(blocked, /Search plan profiles/);
  assert.match(blocked, />New plan profile</);
  assert.match(blocked, /2 required fields remain/);
  assert.equal((blocked.match(/settings-required-dot/g) ?? []).length, 2);
  assert.match(blocked, /settings-primary-action[^>]*disabled/);

  const saved = { ...COMPLETE, contactLensPerBoxCents: undefined };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <CatalogSection
        descriptor={descriptor}
        canWrite
        initialState={{ items: [saved], selectedId: saved.id }}
      />,
    );
  });
  const deactivate = renderer.root.findAllByType("button")
    .find((button) => button.children.join("") === "Deactivate");
  assert.ok(deactivate);
  await act(async () => {
    deactivate.props.onClick();
  });
  assert.match(
    renderer.root.findByProps({ role: "alertdialog" }).findByType("p").children.join(""),
    /VSP Choice remains in historical settings and stops feeding new margin estimates/,
  );
  const editor = renderToStaticMarkup(
    <CatalogSection descriptor={descriptor} canWrite initialState={{ items: [saved], selectedId: saved.id }} />,
  );
  assert.match(editor, /Contact lens per box/);
  assert.doesNotMatch(editor, /Contact lens per box \(cents\)/);
  assert.match(editor, /contact lens \/ box unpriced/);
  act(() => renderer.unmount());
});

test("non-admin route renders the established read-only banner without editor affordances", () => {
  const html = renderToStaticMarkup(<PlanProfilesSettings canWrite={false} />);
  assert.match(html, /Read only. Practice-admin access is required to edit plan profiles/);
  assert.doesNotMatch(html, />New plan profile</);
  assert.doesNotMatch(html, /role="dialog"/);
});

function resourceClient(initial: Basic[]) {
  const resources = initial.map((resource) => structuredClone(resource));
  return {
    resources,
    client: {
      async search<T extends Basic>(): Promise<Bundle<T>> {
        return {
          resourceType: "Bundle",
          type: "searchset",
          entry: resources.map((resource) => ({ resource: resource as T })),
        };
      },
      async searchUrl<T extends Basic>(): Promise<Bundle<T>> {
        return { resourceType: "Bundle", type: "searchset" };
      },
      async create<T extends Basic>(resource: T): Promise<T> {
        const created = {
          ...resource,
          id: resource.id ?? `basic-${resources.length + 1}`,
          meta: { versionId: "1" },
        } as T;
        resources.push(created);
        return created;
      },
      async update<T extends Basic>(resource: T): Promise<T> {
        const index = resources.findIndex((candidate) => candidate.id === resource.id);
        const updated = {
          ...resource,
          meta: { ...resource.meta, versionId: String(Number(resource.meta?.versionId ?? "0") + 1) },
        } as T;
        resources[index] = updated;
        return updated;
      },
    },
  };
}

function buildResource(item: PlanProfileItem): Basic {
  return {
    resourceType: "Basic",
    identifier: [{
      system: "https://odos2020.com/fhir/NamingSystem/plan-profile-key",
      value: item.planKey,
    }],
    code: {
      coding: [{
        system: "https://odos2020.com/fhir/CodeSystem/plan-profile",
        code: "plan-profile",
      }],
      text: item.displayName,
    },
    extension: [{
      url: "https://odos2020.com/fhir/StructureDefinition/odos-plan-profile",
      extension: [{ url: "active", valueBoolean: item.active }],
    }],
  };
}
