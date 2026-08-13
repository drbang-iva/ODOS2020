import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ProcedureChargeList } from "../src/components/charting/ProcedureChargeList";
import {
  procedureChargeApi,
  type ManualProcedureCharge,
  type ProcedureChargeApi,
  type ProcedureChargeChange,
  type ProcedureChargesResponse,
} from "../src/lib/clinical-graph-client";
import { fhir } from "../src/lib/fhir";

const PROPOSAL: ManualProcedureCharge = {
  id: "manual-procedure-charge:synthetic-1",
  procedureConceptKey: "gonioscopy",
  dxPointers: ["Condition/principal"],
  state: "accepted",
};

const RESPONSE: ProcedureChargesResponse = {
  options: [{ procedureConceptKey: "gonioscopy", display: "Gonioscopy", billingCode: "SYNTHA" }],
  diagnoses: [
    { reference: "Condition/principal", display: "Principal diagnosis", rank: 1 },
    { reference: "Condition/secondary", display: "Secondary diagnosis", rank: 2 },
    { reference: "Condition/third", display: "Third diagnosis", rank: 3 },
  ],
  proposals: [],
  attachedProcedures: [],
};

test("procedure charge client sends authenticated narrow GET POST and PATCH requests", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (!init?.method) return Response.json(RESPONSE);
    return Response.json({ proposal: PROPOSAL });
  };
  const originalAuthHeader = fhir.authHeader;
  fhir.authHeader = () => "Bearer synthetic-procedure-token";
  try {
    const api = procedureChargeApi(fetchImpl);
    assert.deepEqual(await api.read("enc-1"), RESPONSE);
    assert.deepEqual(await api.create("enc-1", "gonioscopy"), { proposal: PROPOSAL });
    assert.deepEqual(await api.patch("enc-1", PROPOSAL.id, { laterality: "OD" }), { proposal: PROPOSAL });
  } finally {
    fhir.authHeader = originalAuthHeader;
  }

  assert.equal(requests[0]?.url, "/clinical-graph/protocols/encounters/enc-1/procedure-charges");
  assert.deepEqual(requests[0]?.init, {
    headers: { Authorization: "Bearer synthetic-procedure-token" },
  });
  assert.equal(requests[1]?.url, "/clinical-graph/protocols/encounters/enc-1/procedure-charges");
  assert.equal(requests[1]?.init?.method, "POST");
  assert.deepEqual(requests[1]?.init?.headers, {
    Authorization: "Bearer synthetic-procedure-token",
    "Content-Type": "application/json",
  });
  assert.equal(requests[1]?.init?.body, JSON.stringify({ procedureConceptKey: "gonioscopy" }));
  assert.equal(
    requests[2]?.url,
    "/clinical-graph/protocols/encounters/enc-1/procedure-charges/manual-procedure-charge%3Asynthetic-1",
  );
  assert.equal(requests[2]?.init?.method, "PATCH");
  assert.deepEqual(requests[2]?.init?.headers, {
    Authorization: "Bearer synthetic-procedure-token",
    "Content-Type": "application/json",
  });
  assert.equal(requests[2]?.init?.body, JSON.stringify({ laterality: "OD" }));
});

test("procedure charge client maps non-2xx response errors through the shared boundary", async () => {
  const api = procedureChargeApi(async () => Response.json(
    { error: "Synthetic procedure charge conflict" },
    { status: 409 },
  ));
  await assert.rejects(
    api.patch("enc-1", PROPOSAL.id, { state: "removed" }),
    /Synthetic procedure charge conflict/,
  );
});

test("procedure list loads as a passive blank add row with no uncoded fallback", async () => {
  let creates = 0;
  let patches = 0;
  const api: ProcedureChargeApi = {
    async read() { return RESPONSE; },
    async create() { creates += 1; return { proposal: PROPOSAL }; },
    async patch() { patches += 1; return { proposal: PROPOSAL }; },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ProcedureChargeList encounterId="enc-1" api={api} />);
    await Promise.resolve();
  });

  const addSelect = renderer.root.findByProps({ "aria-label": "Procedure to add" });
  assert.equal(addSelect.props.value, "");
  assert.equal(addSelect.props.disabled, false);
  assert.equal(renderer.root.findByProps({ children: "Add procedure" }).props.disabled, true);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "procedure-charge-row" }).length, 0);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Code unset/);
  assert.equal(creates, 0);
  assert.equal(patches, 0);
  act(() => renderer.unmount());
});

test("procedure list adds then narrowly edits clears and removes one charge", async () => {
  let stored = structuredClone(PROPOSAL);
  const creates: string[] = [];
  const patches: ProcedureChargeChange[] = [];
  const api: ProcedureChargeApi = {
    async read() { return RESPONSE; },
    async create(_encounterId, procedureConceptKey) {
      creates.push(procedureConceptKey);
      stored = structuredClone(PROPOSAL);
      return { proposal: structuredClone(stored) };
    },
    async patch(_encounterId, _proposalId, change) {
      patches.push(structuredClone(change));
      stored = {
        ...stored,
        ...(change.laterality === undefined
          ? {}
          : change.laterality === null ? { laterality: undefined } : { laterality: change.laterality }),
        ...(change.dxPointer === undefined
          ? {}
          : { dxPointers: change.dxPointer === null ? [] : [change.dxPointer] }),
        ...(change.state ? { state: change.state } : {}),
      };
      return { proposal: structuredClone(stored) };
    },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ProcedureChargeList encounterId="enc-1" api={api} />);
    await Promise.resolve();
  });

  await act(async () => {
    renderer.root.findByProps({ "aria-label": "Procedure to add" }).props.onChange({
      target: { value: "gonioscopy" },
    });
  });
  await act(async () => {
    await renderer.root.findByProps({ children: "Add procedure" }).props.onClick();
  });
  assert.deepEqual(creates, ["gonioscopy"]);
  assert.match(JSON.stringify(renderer.toJSON()), /Gonioscopy/);
  assert.match(JSON.stringify(renderer.toJSON()), /SYNTHA/);
  assert.match(JSON.stringify(renderer.toJSON()), /Principal diagnosis/);
  assert.match(JSON.stringify(renderer.toJSON()), /Laterality unset/);

  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Laterality for Gonioscopy" }).props.onChange({
      target: { value: "OD" },
    });
  });
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Diagnosis for Gonioscopy" }).props.onChange({
      target: { value: "Condition/third" },
    });
  });
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Diagnosis for Gonioscopy" }).props.onChange({
      target: { value: "" },
    });
  });
  await act(async () => {
    await renderer.root.findByProps({ children: "Remove" }).props.onClick();
  });

  assert.deepEqual(patches, [
    { laterality: "OD" },
    { dxPointer: "Condition/third" },
    { dxPointer: null },
    { state: "removed" },
  ]);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "procedure-charge-row" }).length, 0);
  act(() => renderer.unmount());
});

test("procedure row mutation failure stays inline while add controls remain available", async () => {
  const api: ProcedureChargeApi = {
    async read() { return { ...RESPONSE, proposals: [PROPOSAL] }; },
    async create() { return { proposal: PROPOSAL }; },
    async patch() { throw new Error("Synthetic procedure patch failure"); },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ProcedureChargeList encounterId="enc-error" api={api} />);
    await Promise.resolve();
  });
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Laterality for Gonioscopy" }).props.onChange({
      target: { value: "OD" },
    });
  });

  assert.match(
    renderer.root.findByProps({ "data-testid": "procedure-charge-error" }).children.join(""),
    /Synthetic procedure patch failure/,
  );
  assert.equal(renderer.root.findByProps({ "aria-label": "Procedure to add" }).props.disabled, false);
  assert.equal(renderer.root.findAll((node) => node.props.role === "dialog").length, 0);
  act(() => renderer.unmount());
});
