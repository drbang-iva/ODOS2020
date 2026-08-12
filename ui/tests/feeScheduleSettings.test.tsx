import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import {
  procedureFeeScheduleAdapter,
  type ProcedureFeeScheduleItem,
} from "../src/lib/procedure-fee-schedule";
import { CatalogEditor } from "../src/scenes/settings/CatalogEditor";
import { feeScheduleDescriptor } from "../src/scenes/settings/FeeScheduleSettings";

const ITEM: ProcedureFeeScheduleItem = {
  id: "gonioscopy",
  procedureConceptKey: "gonioscopy",
  display: "Gonioscopy",
  active: true,
  version: "1",
};

function item(overrides: Partial<ProcedureFeeScheduleItem>): ProcedureFeeScheduleItem {
  return { ...ITEM, ...overrides };
}

test("fee schedule adapter lists, edits, and deactivates through the server-mediated API", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (!init?.method) {
      return Response.json({ items: [ITEM] });
    }
    const body = JSON.parse(String(init.body)) as { action: string; priceCents?: number | null };
    return Response.json({
      item: {
        ...ITEM,
        version: "2",
        active: body.action !== "deactivate",
        ...(body.priceCents === null || body.priceCents === undefined ? {} : { priceCents: body.priceCents }),
      },
    });
  };
  const adapter = procedureFeeScheduleAdapter(fetchImpl);
  assert.deepEqual(await adapter.list(), [ITEM]);
  const priced = await adapter.save({ ...ITEM, priceCents: 8_750 });
  assert.equal(priced.priceCents, 8_750);
  const deactivated = await adapter.deactivate(priced);
  assert.equal(deactivated.active, false);
  assert.deepEqual(requests.map((request) => request.url), [
    "/clinical-graph/fee-schedule",
    "/clinical-graph/fee-schedule/gonioscopy",
    "/clinical-graph/fee-schedule/gonioscopy",
  ]);
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    action: "save",
    priceCents: 8_750,
    active: true,
  });
  assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), { action: "deactivate" });
});

test("fee schedule adapter creates practice concepts through the collection endpoint", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({
      item: item({
        id: "custom-procedure",
        procedureConceptKey: "custom-procedure",
        display: "Custom procedure",
        category: "procedure",
      }),
    }, { status: 201 });
  };
  const created = await procedureFeeScheduleAdapter(fetchImpl).save(item({
    id: "",
    procedureConceptKey: "",
    display: "Custom procedure",
    category: "procedure",
    modifier: "SYNTHMOD",
  }));
  assert.equal(created.procedureConceptKey, "custom-procedure");
  assert.equal(requests[0]?.url, "/clinical-graph/fee-schedule");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    action: "create",
    display: "Custom procedure",
    category: "procedure",
    modifier: "SYNTHMOD",
    priceCents: null,
    active: true,
  });
});

test("Fee Schedule uses CatalogEditor and visibly flags uncoded concepts as not chartable", () => {
  const descriptor = feeScheduleDescriptor({
    capabilities: { reorder: false, deactivate: true, presetSeed: false },
    list: async () => [ITEM],
    save: async (item) => item,
    deactivate: async (item) => ({ ...item, active: false }),
  });
  const html = JSON.stringify(create(
    <CatalogEditor
      descriptor={descriptor}
      canWrite
      initialState={{ items: [ITEM], loading: false }}
    />,
  ).toJSON());
  assert.match(html, /Fee Schedule/);
  assert.match(html, /Gonioscopy/);
  assert.match(html, /Not chartable — no code/);
  assert.match(html, /Unpriced/);
  assert.match(html, /\+ Add a procedure this practice bills/);
});

test("fee worksheet renders fixed section and total coded counts with one shared-code family", () => {
  const family = Array.from({ length: 6 }, (_, index) => item({
    id: `fit-${index + 1}`,
    procedureConceptKey: `fit-${index + 1}`,
    display: `Fitting ${index + 1}`,
    category: "cl-fitting",
    billingCode: "SYNTHA",
    priceCents: 10_000 + index,
  }));
  const items = [
    item({ id: "exam-coded", procedureConceptKey: "exam-coded", display: "Exam coded", category: "exam", billingCode: "SYNTHE" }),
    item({ id: "exam-uncoded", procedureConceptKey: "exam-uncoded", display: "Exam uncoded", category: "exam" }),
    item({ id: "refraction", procedureConceptKey: "refraction", display: "Refraction", category: "refraction" }),
    ...family,
    item({ id: "procedure", procedureConceptKey: "procedure", display: "Procedure", category: "procedure" }),
    item({ id: "inactive", procedureConceptKey: "inactive", display: "Inactive", category: "procedure", billingCode: "SYNTHI", active: false }),
  ];
  const descriptor = feeScheduleDescriptor({
    capabilities: { reorder: false, deactivate: true, presetSeed: false },
    list: async () => items,
    save: async (entry) => entry,
    deactivate: async (entry) => ({ ...entry, active: false }),
  });
  const html = JSON.stringify(create(
    <CatalogEditor descriptor={descriptor} canWrite initialState={{ items, loading: false }} />,
  ).toJSON());
  assert.match(html, /7 of 10 coded/);
  assert.match(html, /Exams[\s\S]*1 of 2 coded/);
  assert.match(html, /Refraction[\s\S]*0 of 1 coded/);
  assert.match(html, /Contact Lens Fittings[\s\S]*6 of 6 coded/);
  assert.match(html, /Procedures[\s\S]*0 of 1 coded/);
  assert.equal(html.match(/"defaultValue":"SYNTHA"/g)?.length, 1);
  assert.match(html, /Family/);
  for (let index = 1; index <= 6; index += 1) assert.match(html, new RegExp(`Fitting ${index}`));
});

test("editing a derived family code updates all six fees without merging their concepts", async () => {
  const persisted = Array.from({ length: 6 }, (_, index) => item({
    id: `fit-${index + 1}`,
    procedureConceptKey: `fit-${index + 1}`,
    display: `Fitting ${index + 1}`,
    category: "cl-fitting",
    billingCode: "SYNTHA",
    priceCents: 10_000 + index,
  }));
  const descriptor = feeScheduleDescriptor({
    capabilities: { reorder: false, deactivate: true, presetSeed: false },
    list: () => persisted,
    save: async (entry) => {
      const index = persisted.findIndex((candidate) => candidate.id === entry.id);
      persisted[index] = structuredClone(entry);
      return structuredClone(entry);
    },
    deactivate: async (entry) => ({ ...entry, active: false }),
  });
  const renderer = create(
    <CatalogEditor descriptor={descriptor} canWrite initialState={{ items: persisted, loading: false }} />,
  );
  const familyCode = renderer.root.findByProps({ "aria-label": "Billing code for 6-concept family" });
  await act(async () => {
    await familyCode.props.onBlur({ currentTarget: { value: "SYNTHB" } });
  });
  assert.deepEqual(persisted.map((entry) => ({
    id: entry.id,
    billingCode: entry.billingCode,
    priceCents: entry.priceCents,
  })), Array.from({ length: 6 }, (_, index) => ({
    id: `fit-${index + 1}`,
    billingCode: "SYNTHB",
    priceCents: 10_000 + index,
  })));
  assert.equal(new Set(persisted.map((entry) => entry.procedureConceptKey)).size, 6);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Billing code for 6-concept family" }).length, 1);
});
