import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

test("Fee Schedule uses CatalogEditor and visibly flags empty-priced concepts", () => {
  const descriptor = feeScheduleDescriptor({
    capabilities: { reorder: false, deactivate: true, presetSeed: false },
    list: async () => [ITEM],
    save: async (item) => item,
    deactivate: async (item) => ({ ...item, active: false }),
  });
  const html = renderToStaticMarkup(
    <CatalogEditor
      descriptor={descriptor}
      canWrite
      initialState={{ items: [ITEM], loading: false }}
    />,
  );
  assert.match(html, /Fee Schedule/);
  assert.match(html, /Gonioscopy/);
  assert.match(html, /No fee set/);
  assert.match(html, /Unpriced/);
  assert.doesNotMatch(html, /New procedure fee/);
});
