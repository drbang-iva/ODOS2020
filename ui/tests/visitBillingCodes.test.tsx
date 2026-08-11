import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  procedureFeeScheduleAdapter,
  type ProcedureFeeScheduleItem,
} from "../src/lib/procedure-fee-schedule";
import { feeScheduleDescriptor } from "../src/scenes/settings/FeeScheduleSettings";
import { VisitCodeSelector } from "../src/components/charting/VisitCodeSelector";
import type { VisitChargeApi, VisitChargeResponse } from "../src/lib/clinical-graph-client";

const ROUTINE_ITEM: ProcedureFeeScheduleItem = {
  id: "routine-vision-exam-new",
  procedureConceptKey: "routine-vision-exam-new",
  display: "Routine vision exam — new patient",
  active: true,
  billingCode: "S0620",
  version: "1",
};

test("fee settings round-trip the optional billing code without enabling item creation", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (!init?.method) return Response.json({ items: [ROUTINE_ITEM] });
    return Response.json({ item: { ...ROUTINE_ITEM, version: "2" } });
  };
  const adapter = procedureFeeScheduleAdapter(fetchImpl);
  assert.deepEqual(await adapter.list(), [ROUTINE_ITEM]);
  assert.equal((await adapter.save(ROUTINE_ITEM)).billingCode, "S0620");
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    action: "save",
    billingCode: "S0620",
    priceCents: null,
    active: true,
  });

  const descriptor = feeScheduleDescriptor(adapter);
  assert.equal(descriptor.canCreate, false);
  assert.deepEqual(descriptor.fields, [
    { type: "text", key: "billingCode", label: "Billing code" },
    { type: "currency", key: "priceCents", label: "Fee", min: 0 },
  ]);
  assert.deepEqual(descriptor.facts?.(ROUTINE_ITEM), ["S0620", "No fee set", "Version 1"]);
  assert.match(descriptor.listGrammar?.searchText?.(ROUTINE_ITEM) ?? "", /S0620/);
  const uncoded = { ...ROUTINE_ITEM, procedureConceptKey: "refraction", display: "Refraction" };
  delete uncoded.billingCode;
  assert.equal(descriptor.facts?.(uncoded).includes("S0620"), false);
});

test("the passive selector starts blank, selects, and clears without another workflow surface", async () => {
  const mutations: Array<string | null> = [];
  const options = visitOptions();
  const api: VisitChargeApi = {
    async read() { return { options }; },
    async save(_encounterId, procedureConceptKey) {
      mutations.push(procedureConceptKey);
      return {
        options,
        ...(procedureConceptKey ? { selectedProcedureConceptKey: procedureConceptKey } : {}),
      };
    },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<VisitCodeSelector encounterId="enc-1" api={api} />);
    await Promise.resolve();
  });
  let select = renderer.root.findByType("select");
  assert.equal(select.props.value, "");
  const renderedOptions = select.findAllByType("option");
  assert.equal(renderedOptions.length, 13);
  assert.equal(renderedOptions.some((option) => option.children.join("").includes("Refraction")), false);
  assert.equal(renderedOptions.some((option) =>
    option.children.join("") === "Routine vision exam — new patient — S0620"
  ), true);
  assert.equal(renderedOptions.some((option) =>
    option.children.join("") === "Comprehensive eye exam — new patient"
  ), true);
  assert.equal(renderer.root.findAll((node) => node.props.role === "dialog").length, 0);
  assert.equal(renderer.root.findAllByType("button").length, 0);

  await act(async () => {
    await select.props.onChange({ target: { value: "routine-vision-exam-new" } });
  });
  select = renderer.root.findByType("select");
  assert.equal(select.props.value, "routine-vision-exam-new");
  await act(async () => {
    await select.props.onChange({ target: { value: "" } });
  });
  assert.equal(renderer.root.findByType("select").props.value, "");
  assert.deepEqual(mutations, ["routine-vision-exam-new", null]);
  act(() => renderer.unmount());
});

test("selector read failure stays local and non-blocking", async () => {
  const api: VisitChargeApi = {
    async read() { throw new Error("Synthetic visit charge read failure"); },
    async save() { throw new Error("not reached"); },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<VisitCodeSelector encounterId="enc-error" api={api} />);
    await Promise.resolve();
  });
  assert.match(renderer.root.findByProps({ "data-testid": "visit-code-error" }).children.join(""), /Synthetic visit charge read failure/);
  assert.equal(renderer.root.findAllByType("button").length, 0);
  act(() => renderer.unmount());
});

function visitOptions(): VisitChargeResponse["options"] {
  return [
    { procedureConceptKey: "comprehensive-exam-new", display: "Comprehensive eye exam — new patient" },
    { procedureConceptKey: "comprehensive-exam-established", display: "Comprehensive eye exam — established patient" },
    { procedureConceptKey: "intermediate-exam-new", display: "Intermediate eye exam — new patient" },
    { procedureConceptKey: "intermediate-exam-established", display: "Intermediate eye exam — established patient" },
    { procedureConceptKey: "office-visit-new-straightforward", display: "Office visit — new, straightforward" },
    { procedureConceptKey: "office-visit-new-low", display: "Office visit — new, low complexity" },
    { procedureConceptKey: "office-visit-new-moderate", display: "Office visit — new, moderate complexity" },
    { procedureConceptKey: "office-visit-established-straightforward", display: "Office visit — established, straightforward" },
    { procedureConceptKey: "office-visit-established-low", display: "Office visit — established, low complexity" },
    { procedureConceptKey: "office-visit-established-moderate", display: "Office visit — established, moderate complexity" },
    { procedureConceptKey: "routine-vision-exam-new", display: "Routine vision exam — new patient", billingCode: "S0620" },
    { procedureConceptKey: "routine-vision-exam-established", display: "Routine vision exam — established", billingCode: "S0621" },
  ];
}
