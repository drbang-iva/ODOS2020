import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEvent, Basic, Bundle, Provenance } from "@medplum/fhirtypes";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  dispenseFrameInventoryUnit,
  dollarsToCentsExact,
  frameSourceUsesPracticeInventory,
  loadPracticeFrameInventoryUnits,
  MAX_RECEIPT_QUANTITY,
  receiveFrameInventory,
  saveFramesDataSubscriptionSettings,
  summarizeInventoryByVariant,
  transitionFrameInventoryUnitStatus,
  type FrameCatalogItem,
  type PracticeFrameInventoryUnit,
} from "../src/lib/optical-frames";
import { RoleProvider } from "../src/lib/role-context";
import { OpticalFrames, type OpticalFramesApi } from "../src/scenes/OpticalFrames";

const BASIC_KIND_SYSTEM = "https://odos2020.com/fhir/CodeSystem/basic-kind";
const CATALOG_URL = "https://odos2020.com/catalog/frames/SKU-100";
const ACTOR_ID = "practitioner-1";
const CATALOG_ITEM: FrameCatalogItem = {
  canonicalUrl: CATALOG_URL,
  sku: "SKU-100",
  display: "Test Frame",
  manufacturer: "ODOS",
  properties: {},
  publicityClass: "open",
};
const URLS = {
  canonical: "https://odos2020.com/fhir/StructureDefinition/catalog-canonical-url",
  cost: "https://odos2020.com/fhir/StructureDefinition/cost-cents",
  location: "https://odos2020.com/fhir/StructureDefinition/dispensary-location",
  receivedAt: "https://odos2020.com/fhir/StructureDefinition/received-at",
  sale: "https://odos2020.com/fhir/StructureDefinition/sale-price-cents",
  status: "https://odos2020.com/fhir/StructureDefinition/unit-status",
} as const;

test("receiveFrameInventory creates the requested units and priced settings in one audited transaction", async () => {
  let transaction: Bundle | undefined;
  let transactionCalls = 0;
  const result = await withFetch(async (input, init) => {
    const url = String(input);
    if (url.includes("/Basic?") && (!init?.method || init.method === "GET")) {
      return jsonResponse({ resourceType: "Bundle", type: "searchset" });
    }
    if (url.endsWith("/fhir/R4") && init?.method === "POST") {
      transactionCalls += 1;
      transaction = JSON.parse(String(init.body)) as Bundle;
      return transactionResponse([
        "http://localhost:8103/fhir/R4/Basic/unit-1/_history/1",
        ...Array.from({ length: 5 }, (_, index) => `Basic/unit-${index + 2}/_history/1`),
        "Basic/settings-1/_history/1",
        "AuditEvent/audit-1/_history/1",
        "Provenance/provenance-1/_history/1",
      ]);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }, () => receiveFrameInventory(CATALOG_ITEM, {
    quantity: 6,
    salePriceCents: 17_900,
    costCents: 8_499,
    location: " Optical Front ",
  }, ACTOR_ID));

  assert.equal(transactionCalls, 1);
  assert.equal(result.units.length, 6);
  assert.equal(result.variantSettings?.salePriceCents, 17_900);
  assert.equal(result.variantSettings?.costCents, 8_499);
  assert.equal(transaction?.entry?.length, 9);
  const units = transaction?.entry?.slice(0, 6).map((entry) => entry.resource as Basic) ?? [];
  assert.equal(units.every((unit) => unit.code.coding?.[0]?.code === "practice-frame-inventory-unit"), true);
  assert.equal(units.every((unit) => extensionValue(unit, URLS.status) === "on_hand"), true);
  assert.equal(units.every((unit) => extensionValue(unit, URLS.location) === "Optical Front"), true);
  assert.equal(units.every((unit) => typeof extensionValue(unit, URLS.receivedAt) === "string"), true);
  assert.equal(new Set(transaction?.entry?.slice(0, 6).map((entry) => entry.fullUrl)).size, 6);

  const settings = transaction?.entry?.[6]?.resource as Basic;
  assert.equal(settings.code.coding?.[0]?.code, "practice-frame-variant-settings");
  assert.equal(extensionValue(settings, URLS.sale), 17_900);
  assert.equal(extensionValue(settings, URLS.cost), 8_499);
  assert.equal(Number.isInteger(extensionValue(settings, URLS.sale)), true);
  assert.equal(Number.isInteger(extensionValue(settings, URLS.cost)), true);
  assert.match(transaction?.entry?.[6]?.request?.ifNoneExist ?? "", /frame-variant-settings-canonical-url/);

  const audit = transaction?.entry?.[7]?.resource as AuditEvent;
  const provenance = transaction?.entry?.[8]?.resource as Provenance;
  assert.equal(audit.type.code, "practice.frame-inventory.received");
  assert.deepEqual(
    audit.entity?.slice(0, 6).map((entity) => entity.what?.reference),
    transaction?.entry?.slice(0, 6).map((entry) => entry.fullUrl),
  );
  assert.equal(audit.agent[0]?.who?.reference, `Practitioner/${ACTOR_ID}`);
  assert.equal(provenance.target.length, 7);
  assert.equal(provenance.agent[0]?.who.reference, `Practitioner/${ACTOR_ID}`);
});

test("receiveFrameInventory omits variant settings and blank locations when no defaults are supplied", async () => {
  let transaction: Bundle | undefined;
  let requests = 0;
  const result = await withFetch(async (input, init) => {
    requests += 1;
    const url = String(input);
    if (url.endsWith("/fhir/R4") && init?.method === "POST") {
      transaction = JSON.parse(String(init.body)) as Bundle;
      return transactionResponse([
        "Basic/unit-1/_history/1",
        "Basic/unit-2/_history/1",
        "AuditEvent/audit-1/_history/1",
        "Provenance/provenance-1/_history/1",
      ]);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }, () => receiveFrameInventory(CATALOG_ITEM, { quantity: 2, location: "   " }, ACTOR_ID));

  assert.equal(requests, 1);
  assert.equal(result.variantSettings, undefined);
  assert.equal(transaction?.entry?.length, 4);
  assert.equal(transaction?.entry?.some((entry) =>
    (entry.resource as Basic).code?.coding?.[0]?.code === "practice-frame-variant-settings"), false);
  assert.equal((transaction?.entry?.[0]?.resource as Basic).extension?.some((entry) => entry.url === URLS.location), false);
});

test("receiveFrameInventory version-safely upserts an existing variant settings Basic", async () => {
  const existing: Basic = {
    resourceType: "Basic",
    id: "settings-1",
    code: { coding: [{ system: BASIC_KIND_SYSTEM, code: "practice-frame-variant-settings" }] },
    extension: [
      { url: URLS.canonical, valueString: CATALOG_URL },
      { url: URLS.cost, valueInteger: 7_500 },
    ],
  };
  let transaction: Bundle | undefined;
  const searches: string[] = [];
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.includes("/Basic?") && (!init?.method || init.method === "GET")) {
      searches.push(url);
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [{ resource: existing }] });
    }
    if (url.endsWith("/Basic/settings-1") && (!init?.method || init.method === "GET")) {
      return jsonResponse({ ...existing, meta: { versionId: "7" } });
    }
    if (url.endsWith("/fhir/R4") && init?.method === "POST") {
      transaction = JSON.parse(String(init.body)) as Bundle;
      return transactionResponse([
        "Basic/unit-1/_history/1",
        "Basic/settings-1/_history/8",
        "AuditEvent/audit-1/_history/1",
        "Provenance/provenance-1/_history/1",
      ], ["201 Created", "200 OK", "201 Created", "201 Created"]);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }, () => receiveFrameInventory(CATALOG_ITEM, { quantity: 1, salePriceCents: 17_900 }, ACTOR_ID));

  const settingsEntry = transaction?.entry?.[1];
  assert.equal(settingsEntry?.request?.method, "PUT");
  assert.equal(settingsEntry?.request?.url, "Basic/settings-1");
  assert.equal(settingsEntry?.request?.ifMatch, 'W/"7"');
  assert.equal(extensionValue(settingsEntry?.resource as Basic, URLS.sale), 17_900);
  assert.equal(extensionValue(settingsEntry?.resource as Basic, URLS.cost), 7_500);
  assert.equal(searches.length, 1);
  assert.match(searches[0] ?? "", /identifier=/);
});

test("receipt validation rejects invalid quantities and prices before any FHIR request", async () => {
  for (const input of [
    { quantity: 0 },
    { quantity: -1 },
    { quantity: 1.5 },
    { quantity: MAX_RECEIPT_QUANTITY + 1 },
    { quantity: 1, salePriceCents: -1 },
    { quantity: 1, costCents: -1 },
  ]) {
    let requests = 0;
    await assert.rejects(withFetch(async () => {
      requests += 1;
      return jsonResponse({});
    }, () => receiveFrameInventory(CATALOG_ITEM, input, ACTOR_ID)));
    assert.equal(requests, 0);
  }
  await assert.rejects(
    receiveFrameInventory(CATALOG_ITEM, { quantity: 201 }, ACTOR_ID),
    /cannot exceed 200 units/,
  );
  assert.equal(dollarsToCentsExact("179.00"), 17_900);
  assert.equal(dollarsToCentsExact("84.99"), 8_499);
  assert.throws(() => dollarsToCentsExact("-1.00"), /nonnegative/);
  assert.throws(() => dollarsToCentsExact("1.001"), /two decimal/);
});

test("dispenseFrameInventoryUnit performs an audited version-safe status patch", async () => {
  const current = unitBasic("unit-1", "on_hand", { versionId: "4" });
  let transaction: Bundle | undefined;
  const updated = await withFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/Basic/unit-1") && (!init?.method || init.method === "GET")) {
      return jsonResponse(current);
    }
    if (url.endsWith("/fhir/R4") && init?.method === "POST") {
      transaction = JSON.parse(String(init.body)) as Bundle;
      return transactionResponse([
        "Basic/unit-1/_history/5",
        "AuditEvent/audit-1/_history/1",
        "Provenance/provenance-1/_history/1",
      ], ["200 OK", "201 Created", "201 Created"]);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }, () => dispenseFrameInventoryUnit("unit-1", ACTOR_ID));

  assert.equal(updated.status, "dispensed");
  const patchEntry = transaction?.entry?.[0];
  assert.equal(patchEntry?.request?.method, "PATCH");
  assert.equal(patchEntry?.request?.url, "Basic/unit-1");
  assert.equal(patchEntry?.request?.ifMatch, 'W/"4"');
  const patch = JSON.parse(Buffer.from((patchEntry?.resource as { data?: string }).data ?? "", "base64").toString("utf8"));
  assert.deepEqual(patch, [
    { op: "test", path: "/extension/1/url", value: URLS.status },
    { op: "test", path: "/extension/1/valueString", value: "on_hand" },
    { op: "replace", path: "/extension/1/valueString", value: "dispensed" },
  ]);
  assert.equal((transaction?.entry?.[1]?.resource as AuditEvent).type.code, "practice.frame-inventory.dispensed");
  assert.equal((transaction?.entry?.[1]?.resource as AuditEvent).entity?.[0]?.what?.reference, "Basic/unit-1");
  assert.equal((transaction?.entry?.[2]?.resource as Provenance).target[0]?.reference, "Basic/unit-1");
});

test("dispenseFrameInventoryUnit is idempotent without writing when the unit is already dispensed", async () => {
  let writes = 0;
  const result = await withFetch(async (input, init) => {
    if (String(input).endsWith("/Basic/unit-1") && (!init?.method || init.method === "GET")) {
      return jsonResponse(unitBasic("unit-1", "dispensed", { versionId: "2" }));
    }
    writes += 1;
    return jsonResponse({});
  }, () => dispenseFrameInventoryUnit("unit-1", ACTOR_ID));
  assert.equal(result.status, "dispensed");
  assert.equal(writes, 0);
});

test("frame-source inventory gate is strict for every shipped non-inventory combination", () => {
  assert.equal(frameSourceUsesPracticeInventory(4, "in-house"), true);
  assert.equal(frameSourceUsesPracticeInventory(0, undefined), false);
  assert.equal(frameSourceUsesPracticeInventory(1, undefined), false);
  assert.equal(frameSourceUsesPracticeInventory(3, "in-house"), false);
  assert.equal(frameSourceUsesPracticeInventory(3, "patients-own"), false);
  assert.equal(frameSourceUsesPracticeInventory(4, "patients-own"), false);
});

test("one physical unit walks the audited lab ladder and repeated status is idempotent", async () => {
  let current = unitBasic("unit-1", "on_hand", { versionId: "1" });
  const events: string[] = [];
  let writes = 0;
  const statuses = ["reserved", "outbound", "at_lab", "inbound", "dispensed"] as const;

  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/Basic/unit-1") && (!init?.method || init.method === "GET")) {
      return jsonResponse(current);
    }
    if (url.endsWith("/fhir/R4") && init?.method === "POST") {
      writes += 1;
      const transaction = JSON.parse(String(init.body)) as Bundle;
      const audit = transaction.entry?.[1]?.resource as AuditEvent;
      events.push(audit.type.code);
      const patch = JSON.parse(Buffer.from(
        (transaction.entry?.[0]?.resource as { data?: string }).data ?? "",
        "base64",
      ).toString("utf8")) as Array<{ op: string; value: string }>;
      const next = patch.at(-1)?.value as PracticeFrameInventoryUnit["status"];
      current = unitBasic("unit-1", next, { versionId: String(writes + 1) });
      return transactionResponse([
        `Basic/unit-1/_history/${writes + 1}`,
        `AuditEvent/audit-${writes}/_history/1`,
        `Provenance/provenance-${writes}/_history/1`,
      ], ["200 OK", "201 Created", "201 Created"]);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }, async () => {
    let from: PracticeFrameInventoryUnit["status"] = "on_hand";
    for (const to of statuses) {
      const updated = await transitionFrameInventoryUnitStatus("unit-1", from, to, ACTOR_ID);
      assert.equal(updated.status, to);
      from = to;
    }
    const repeated = await transitionFrameInventoryUnitStatus("unit-1", "inbound", "dispensed", ACTOR_ID);
    assert.equal(repeated.status, "dispensed");
  });

  assert.equal(writes, 5);
  assert.deepEqual(events, [
    "practice.frame-inventory.reserved",
    "practice.frame-inventory.outbound",
    "practice.frame-inventory.at-lab",
    "practice.frame-inventory.inbound",
    "practice.frame-inventory.dispensed",
  ]);
});

test("cancel releases every committed stage and a stale unit fails without a silent swap", async () => {
  for (const status of ["reserved", "outbound", "at_lab", "inbound"] as const) {
    let writes = 0;
    const result = await withFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/Basic/unit-1") && (!init?.method || init.method === "GET")) {
        return jsonResponse(unitBasic("unit-1", status, { versionId: "7" }));
      }
      if (url.endsWith("/fhir/R4") && init?.method === "POST") {
        writes += 1;
        return transactionResponse([
          "Basic/unit-1/_history/8",
          "AuditEvent/audit-1/_history/1",
          "Provenance/provenance-1/_history/1",
        ], ["200 OK", "201 Created", "201 Created"]);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }, () => transitionFrameInventoryUnitStatus(
      "unit-1",
      ["reserved", "outbound", "at_lab", "inbound"],
      "on_hand",
      ACTOR_ID,
    ));
    assert.equal(result.status, "on_hand");
    assert.equal(writes, 1);
  }

  let staleWrites = 0;
  await assert.rejects(withFetch(async (input, init) => {
    if (String(input).endsWith("/Basic/unit-1") && (!init?.method || init.method === "GET")) {
      return jsonResponse(unitBasic("unit-1", "dispensed", { versionId: "9" }));
    }
    staleWrites += 1;
    return jsonResponse({});
  }, () => transitionFrameInventoryUnitStatus("unit-1", "reserved", "at_lab", ACTOR_ID)), /changed on another terminal.*Dispensed/);
  assert.equal(staleWrites, 0);
});

test("loadPracticeFrameInventoryUnits skips and counts malformed rows without hiding valid units", async () => {
  const malformedStatus = unitBasic("bad-status", "on_hand");
  malformedStatus.extension = malformedStatus.extension?.map((entry) =>
    entry.url === URLS.status ? { ...entry, valueString: "lost" } : entry);
  const missingReceivedAt = unitBasic("missing-received", "on_hand");
  missingReceivedAt.extension = missingReceivedAt.extension?.filter((entry) => entry.url !== URLS.receivedAt);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const result = await withFetch(async () => jsonResponse({
      resourceType: "Bundle",
      type: "searchset",
      entry: [
        { resource: unitBasic("valid", "on_hand") },
        { resource: malformedStatus },
        { resource: missingReceivedAt },
      ],
    }), () => loadPracticeFrameInventoryUnits());

    assert.deepEqual(result.units.map((entry) => entry.id), ["valid"]);
    assert.equal(result.skippedCount, 2);
    assert.equal(warnings.length, 2);
    assert.match(String(warnings[0]?.[0]), /bad-status/);
    assert.match(String(warnings[1]?.[0]), /missing-received/);
  } finally {
    console.warn = originalWarn;
  }
});

test("conditional-create races return the variant settings resource actually persisted by the server", async () => {
  const persisted: Basic = {
    resourceType: "Basic",
    id: "settings-winner",
    code: { coding: [{ system: BASIC_KIND_SYSTEM, code: "practice-frame-variant-settings" }] },
    extension: [
      { url: URLS.canonical, valueString: CATALOG_URL },
      { url: URLS.sale, valueInteger: 18_500 },
      { url: URLS.cost, valueInteger: 8_000 },
    ],
  };
  let searchCalls = 0;
  const result = await withFetch(async (input, init) => {
    const url = String(input);
    if (url.includes("/Basic?") && (!init?.method || init.method === "GET")) {
      searchCalls += 1;
      return jsonResponse({ resourceType: "Bundle", type: "searchset" });
    }
    if (url.endsWith("/fhir/R4") && init?.method === "POST") {
      return transactionResponse([
        "Basic/unit-1/_history/1",
        "http://localhost:8103/fhir/R4/Basic/settings-winner/_history/4",
        "AuditEvent/audit-1/_history/1",
        "Provenance/provenance-1/_history/1",
      ], ["201 Created", "200 OK", "201 Created", "201 Created"]);
    }
    if (url.endsWith("/Basic/settings-winner") && (!init?.method || init.method === "GET")) {
      return jsonResponse(persisted);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }, () => receiveFrameInventory(CATALOG_ITEM, {
    quantity: 1,
    salePriceCents: 17_900,
    costCents: 8_499,
  }, ACTOR_ID));

  assert.equal(searchCalls, 2);
  assert.equal(result.variantSettings?.id, "settings-winner");
  assert.equal(result.variantSettings?.salePriceCents, 18_500);
  assert.equal(result.variantSettings?.costCents, 8_000);
});

test("summarizeInventoryByVariant counts mixed unit states and joins optional settings", () => {
  const secondUrl = "https://odos2020.com/catalog/frames/SKU-200";
  const units: PracticeFrameInventoryUnit[] = [
    unit("unit-1", CATALOG_URL, "on_hand", "Optical Front"),
    unit("unit-2", CATALOG_URL, "on_hand", "Optical Front"),
    unit("unit-3", CATALOG_URL, "reserved", "Optical Front"),
    unit("unit-4", CATALOG_URL, "outbound", "Optical Front"),
    unit("unit-5", CATALOG_URL, "at_lab", "Optical Front"),
    unit("unit-6", CATALOG_URL, "inbound", "Optical Front"),
    unit("unit-7", CATALOG_URL, "hold", "Optical Front"),
    unit("unit-8", CATALOG_URL, "dispensed", "Optical Front"),
    unit("unit-9", secondUrl, "dispensed"),
  ];
  const rows = summarizeInventoryByVariant(
    units,
    [{ id: "settings-1", canonicalUrl: CATALOG_URL, salePriceCents: 17_900 }],
    [CATALOG_ITEM],
  );
  assert.deepEqual(rows[0], {
    canonicalUrl: CATALOG_URL,
    onHandCount: 2,
    reservedCount: 1,
    outboundCount: 1,
    atLabCount: 1,
    inboundCount: 1,
    committedCount: 4,
    holdCount: 1,
    dispensedCount: 1,
    salePriceCents: 17_900,
    location: "Optical Front",
  });
  assert.deepEqual(rows[1], {
    canonicalUrl: secondUrl,
    onHandCount: 0,
    reservedCount: 0,
    outboundCount: 0,
    atLabCount: 0,
    inboundCount: 0,
    committedCount: 0,
    holdCount: 0,
    dispensedCount: 1,
  });
});

test("Receipt form forces an explicit quantity, converts optional dollars exactly, and surfaces failures", async () => {
  let receivedInput: Parameters<OpticalFramesApi["receiveInventory"]>[1] | undefined;
  const api = testApi({
    receiveInventory: async (_item, input) => {
      receivedInput = input;
      return {
        units: Array.from({ length: input.quantity }, (_, index) =>
          unit(`unit-${index + 1}`, CATALOG_URL, "on_hand", input.location)),
        variantSettings: {
          id: "settings-1",
          canonicalUrl: CATALOG_URL,
          salePriceCents: input.salePriceCents,
          costCents: input.costCents,
        },
      };
    },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<OpticalFrames route="catalog" api={api} />); });
  const receiptButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Receipt");
  assert.ok(receiptButton);
  act(() => receiptButton.props.onClick());
  const quantity = renderer.root.findByProps({ "aria-label": "Quantity" });
  assert.equal(quantity.props.value, "");
  assert.equal(quantity.props.required, true);
  assert.equal(quantity.props.min, "1");
  assert.equal(quantity.props.max, MAX_RECEIPT_QUANTITY);
  assert.equal(quantity.props.type, "number");
  act(() => {
    quantity.props.onChange({ target: { value: "6" } });
    renderer.root.findByProps({ "aria-label": "Sale price" }).props.onChange({ target: { value: "179.00" } });
    renderer.root.findByProps({ "aria-label": "Cost" }).props.onChange({ target: { value: "84.99" } });
    renderer.root.findByProps({ "aria-label": "Location" }).props.onChange({ target: { value: "Optical Front" } });
  });
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "Receive Test Frame" }).props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
  });
  assert.deepEqual(receivedInput, {
    quantity: 6,
    salePriceCents: 17_900,
    costCents: 8_499,
    location: "Optical Front",
  });
  assert.ok(renderer.root.findAllByType("button").some((button) => button.children.join("") === "Received 6 ✓"));

  const failingApi = testApi({ receiveInventory: async () => { throw new Error("Receipt transaction failed"); } });
  await act(async () => {
    renderer.unmount();
    renderer = create(<OpticalFrames route="catalog" api={failingApi} />);
  });
  act(() => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Receipt")?.props.onClick());
  act(() => renderer.root.findByProps({ "aria-label": "Quantity" }).props.onChange({ target: { value: "1" } }));
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "Receive Test Frame" }).props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
  });
  assert.equal(renderer.root.findByProps({ role: "alert" }).children.join(""), "Receipt transaction failed");
});

test("Inventory ledger expands to individual units and decrements its rollup without reloading", async () => {
  let loadCalls = 0;
  const initialUnits = Array.from({ length: 6 }, (_, index) =>
    unit(`unit-${index + 1}`, CATALOG_URL, "on_hand", "Optical Front"));
  const api = testApi({
    loadInventoryUnits: async () => {
      loadCalls += 1;
      return { units: initialUnits, skippedCount: 0 };
    },
    loadVariantSettings: async () => [{
      id: "settings-1",
      canonicalUrl: CATALOG_URL,
      salePriceCents: 17_900,
      costCents: 8_499,
    }],
    dispenseUnit: async (unitId) => ({ ...initialUnits.find((entry) => entry.id === unitId)!, status: "dispensed" }),
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<RoleProvider><OpticalFrames route="inventory" api={api} /></RoleProvider>);
  });
  assert.equal(ledgerOnHand(renderer), "6");
  const expand = renderer.root.findByProps({ "aria-label": "Expand Test Frame" });
  act(() => expand.props.onClick());
  assert.equal(renderer.root.findAllByType("td").filter((cell) => cell.props.className === "py-2 font-mono").length, 6);
  assert.equal(renderer.root.findAllByType("button").filter((button) => button.children.join("") === "Mark Dispensed").length, 6);
  const mark = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Mark Dispensed");
  assert.ok(mark);
  await act(async () => {
    mark.props.onClick();
    await Promise.resolve();
  });
  assert.equal(ledgerOnHand(renderer), "5");
  assert.ok(renderer.root.findAllByType("td").some((cell) => cell.children.join("") === "Dispensed"));
  assert.equal(loadCalls, 1);
});

test("malformed-unit warnings stay visible across catalog, inventory, and POS routes", async () => {
  for (const route of ["catalog", "inventory", "lookup"] as const) {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RoleProvider><OpticalFrames
        route={route}
        api={testApi({
          loadInventoryUnits: async () => ({ units: [], skippedCount: 2 }),
        })}
      /></RoleProvider>);
      await flushPromises();
    });
    assert.match(renderer.root.findByProps({ role: "alert" }).children.join(""), /Skipped 2 malformed frame inventory units/);
    act(() => renderer.unmount());
  }
});

test("Frames Data settings omit an invalid empty FHIR string and surface transaction failures", async () => {
  let transaction: Bundle | undefined;
  await withFetch(async (_input, init) => {
    transaction = JSON.parse(String(init?.body)) as Bundle;
    return transactionResponse([
      "Basic/settings-1/_history/1",
      "AuditEvent/audit-1/_history/1",
      "Provenance/provenance-1/_history/1",
    ]);
  }, () => saveFramesDataSubscriptionSettings({
    practiceId: "odos-practice",
    actorId: ACTOR_ID,
    settings: { username: "", active: false },
  }));
  const settings = transaction?.entry?.[0]?.resource as Basic;
  assert.equal(settings.extension?.some((extension) => extension.url?.endsWith("frames-data-username")), false);

  await assert.rejects(withFetch(async () => jsonResponse({
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [
      { response: { status: "400 Bad Request", outcome: { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "invalid", diagnostics: "Invalid settings Basic" }] } } },
      { response: { status: "424 Failed Dependency" } },
      { response: { status: "424 Failed Dependency" } },
    ],
  }), () => saveFramesDataSubscriptionSettings({
    practiceId: "odos-practice",
    actorId: ACTOR_ID,
    settings: { username: "frames-user", active: true },
  })), /400 Bad Request.*Invalid settings Basic/);
});

test("Frames Data active subscriptions require a nonempty username before writing", async () => {
  let requests = 0;
  await assert.rejects(withFetch(async () => {
    requests += 1;
    return jsonResponse({});
  }, () => saveFramesDataSubscriptionSettings({
    practiceId: "odos-practice",
    actorId: ACTOR_ID,
    settings: { username: "   ", active: true },
  })), /username is required/);
  assert.equal(requests, 0);
});

function unit(
  id: string,
  canonicalUrl: string,
  status: PracticeFrameInventoryUnit["status"],
  location?: string,
): PracticeFrameInventoryUnit {
  return {
    id,
    canonicalUrl,
    status,
    receivedAt: "2026-07-25T12:00:00.000Z",
    ...(location ? { location } : {}),
  };
}

function unitBasic(
  id: string,
  status: PracticeFrameInventoryUnit["status"],
  meta?: Basic["meta"],
): Basic {
  return {
    resourceType: "Basic",
    id,
    meta,
    code: { coding: [{ system: BASIC_KIND_SYSTEM, code: "practice-frame-inventory-unit" }] },
    extension: [
      { url: URLS.canonical, valueString: CATALOG_URL },
      { url: URLS.status, valueString: status },
      { url: URLS.receivedAt, valueDateTime: "2026-07-25T12:00:00.000Z" },
    ],
  };
}

function extensionValue(resource: Basic, url: string): unknown {
  const entry = resource.extension?.find((extension) => extension.url === url);
  return entry?.valueString ?? entry?.valueDateTime ?? entry?.valueInteger;
}

function testApi(overrides: Partial<OpticalFramesApi> = {}): OpticalFramesApi {
  return {
    searchCatalog: async () => [CATALOG_ITEM],
    loadInventoryUnits: async () => ({ units: [], skippedCount: 0 }),
    loadVariantSettings: async () => [],
    receiveInventory: async () => ({ units: [] }),
    dispenseUnit: async () => { throw new Error("Unexpected dispense"); },
    ...overrides,
  };
}

function ledgerOnHand(renderer: ReactTestRenderer): string {
  const outerRows = renderer.root.findAllByType("tr");
  const ledgerRow = outerRows.find((row) => row.findAllByType("td").length === 8);
  assert.ok(ledgerRow);
  return ledgerRow.findAllByType("td")[2]?.children.join("") ?? "";
}

function transactionResponse(locations: string[], statuses?: string[]): Response {
  return jsonResponse({
    resourceType: "Bundle",
    type: "transaction-response",
    entry: locations.map((location, index) => ({
      response: { status: statuses?.[index] ?? "201 Created", location },
    })),
  });
}

async function withFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchImpl });
  try {
    return await run();
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/fhir+json" } });
}
