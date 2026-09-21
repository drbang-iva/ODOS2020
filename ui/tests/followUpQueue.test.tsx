import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { FollowUpQueue } from "../src/components/charting/FollowUpQueue";

function text(node: unknown): string { return JSON.stringify(node); }
const payload = { recorded: true, rows: [
  { orderable: "photos", label: "Optic nerve photos", state: "already-ordered", actionIds: ["order-1"], sources: ["from the Glaucoma shape"] },
  { orderable: "field", label: "Visual field", state: "for-review", sources: ["from the Glaucoma shape", "from the Second shape"] },
  { orderable: "erg", label: "ERG", state: "unavailable", reason: "Frozen unavailable reason", sources: ["from the Retina shape"] },
] };
async function mounted(reply: () => Promise<Response>, active = true) {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return reply(); };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<FollowUpQueue encounterId="e1" active={active} />); });
  return { renderer, calls: () => calls, async close() { await act(async () => renderer.unmount()); globalThis.fetch = previous; } };
}

test("S3c2a G11 hidden mounted queue never fetches; each selection fetches once", async () => {
  const h = await mounted(async () => Response.json(payload), false);
  try {
    assert.equal(h.calls(), 0);
    await act(async () => h.renderer.update(<FollowUpQueue encounterId="e1" active />));
    assert.equal(h.calls(), 1);
    await act(async () => h.renderer.update(<FollowUpQueue encounterId="e1" active={false} />));
    assert.equal(h.calls(), 1);
    await act(async () => h.renderer.update(<FollowUpQueue encounterId="e1" active />));
    assert.equal(h.calls(), 2);
  } finally { await h.close(); }
});

test("S3c2a G12 failure has polite status and retry, never emptiness or alert", async () => {
  let failed = true;
  const h = await mounted(async () => failed ? new Response("failure", { status: 502 }) : Response.json(payload));
  try {
    const view = text(h.renderer.toJSON());
    assert.match(view, /The tests for this visit could not be loaded\./);
    assert.doesNotMatch(view, /No tests were recorded|No tests are proposed/);
    assert.equal(h.renderer.root.findAllByProps({ role: "alert" }).length, 0);
    assert.match(text(h.renderer.root.findByProps({ role: "status" }).findByType("p").children), /could not be loaded/);
    failed = false;
    await act(async () => h.renderer.root.findByType("button").props.onClick());
    assert.equal(h.calls(), 2); assert.match(text(h.renderer.toJSON()), /Optic nerve photos/);
  } finally { await h.close(); }
});

test("S3c2a G13 all three states show labels, sources and reasons without row buttons", async () => {
  const h = await mounted(async () => Response.json(payload));
  try {
    const rows = h.renderer.root.findAllByType("li");
    assert.equal(rows.length, 3);
    for (const row of rows) assert.equal(row.findAllByType("button").length, 0);
    const view = text(h.renderer.toJSON());
    for (const value of ["For review", "Already ordered", "Unavailable", "Frozen unavailable reason", "from the Second shape"]) assert.ok(view.includes(value), value);
  } finally { await h.close(); }
});

test("S3c2a absent, empty, loading and malformed responses are distinct", async () => {
  for (const [body, expected] of [[{ recorded: false }, "No tests were recorded when this visit opened."], [{ recorded: true, rows: [] }, "No tests are proposed for this visit."], [{ recorded: true }, "The tests for this visit could not be loaded."]] as const) {
    const h = await mounted(async () => Response.json(body));
    try { assert.ok(text(h.renderer.toJSON()).includes(expected)); } finally { await h.close(); }
  }
  let resolve!: (response: Response) => void;
  const h = await mounted(() => new Promise(r => { resolve = r; }));
  try {
    assert.match(text(h.renderer.toJSON()), /Loading tests/);
    assert.doesNotMatch(text(h.renderer.toJSON()), /No tests|could not be loaded/);
    await act(async () => resolve(Response.json(payload)));
    assert.match(text(h.renderer.toJSON()), /Visual field/);
  } finally { await h.close(); }
});

test("S3c2a late response from another encounter cannot replace current tests", async () => {
  let resolve!: (response: Response) => void; let first = true;
  const h = await mounted(() => { if (first) { first = false; return new Promise(r => { resolve = r; }); } return Promise.resolve(Response.json({ recorded: true, rows: [] })); });
  try {
    await act(async () => h.renderer.update(<FollowUpQueue encounterId="e2" active />));
    await act(async () => resolve(Response.json(payload)));
    assert.match(text(h.renderer.toJSON()), /No tests are proposed/);
    assert.doesNotMatch(text(h.renderer.toJSON()), /Optic nerve photos/);
  } finally { await h.close(); }
});

const decisionAt = "2026-09-21T14:05:00.000Z";
const decisionPayload = { recorded: true, canDecide: true, rows: [
  { orderable: "photos", focus: "optic nerve", label: "Optic nerve photos", state: "for-review", sources: ["from the Glaucoma shape"] },
  { orderable: "field", label: "Visual field", state: "not-today", sources: [], decidedBy: "Tech Synthetic", decidedAt: decisionAt },
  { orderable: "ordered", label: "Ordered test", state: "already-ordered", actionIds: ["one"], sources: [] },
  { orderable: "unavailable", label: "Unavailable test", state: "unavailable", reason: "Not available", sources: [] },
] };
async function decisionMounted(reply: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, value: unknown = decisionPayload) {
  const previous = globalThis.fetch; let gets = 0;
  globalThis.fetch = async (input, init) => { if (init?.method === "PUT") return reply(input, init); gets++; return Response.json(value); };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<FollowUpQueue encounterId="e1" active />); });
  return { renderer, gets: () => gets, async close() { await act(async () => renderer.unmount()); globalThis.fetch = previous; } };
}

test("S3c2b G12 buttons follow state and permission without Accept", async () => {
  for (const canDecide of [true, false, undefined]) {
    const h = await decisionMounted(async () => Response.json(decisionPayload), { ...decisionPayload, canDecide });
    try {
      const rows = h.renderer.root.findAllByType("li"); assert.equal(rows.length, 4);
      assert.deepEqual(rows.map(row => row.findAllByType("button").map(button => button.children.join(""))), canDecide ? [["Not today"], ["Put back"], [], []] : [[], [], [], []]);
      assert.doesNotMatch(text(h.renderer.toJSON()), /Accept/);
    } finally { await h.close(); }
  }
});

test("S3c2b G13 failure is scoped, polite, exact and re-enables the row", async () => {
  const { CONCURRENT_EDIT_MESSAGE } = await import("../src/lib/fhir");
  for (const [body, expected] of [[{ code: "concurrent-edit", error: "raw wording" }, CONCURRENT_EDIT_MESSAGE], [{ error: "Signed encounter cannot be edited." }, "Signed encounter cannot be edited."]] as const) {
    let resolve!: (response: Response) => void;
    const h = await decisionMounted(() => new Promise(r => { resolve = r; }));
    try {
      const before = h.renderer.root.findAllByType("li").slice(1).map(row => text(row.findAllByType("button").map(b => b.children)));
      await act(async () => { void h.renderer.root.findAllByType("li")[0].findByType("button").props.onClick(); });
      assert.equal(h.renderer.root.findAllByType("li")[0].findByType("button").props.disabled, true);
      assert.equal(h.renderer.root.findAllByType("li")[1].findByType("button").props.disabled, false);
      await act(async () => resolve(Response.json(body, { status: 409 })));
      const rows = h.renderer.root.findAllByType("li");
      assert.equal(rows[0].findByProps({ role: "status" }).children.join(""), expected);
      assert.equal(rows[0].findByType("button").props.disabled, false);
      assert.deepEqual(rows.slice(1).map(row => text(row.findAllByType("button").map(b => b.children))), before);
      assert.equal(h.renderer.root.findAllByProps({ role: "alert" }).length, 0);
      assert.equal(h.renderer.root.findAllByProps({ role: "status" }).length, 1);
      assert.doesNotMatch(text(h.renderer.toJSON()), /The tests for this visit could not be loaded/);
    } finally { await h.close(); }
  }
});

test("S3c2b G14 successful PUT replaces the complete list with no GET", async () => {
  const updated = { ...decisionPayload, rows: [{ ...decisionPayload.rows[0], state: "not-today", decidedBy: "Doctor Synthetic", decidedAt: decisionAt }] };
  const calls: unknown[] = [];
  const h = await decisionMounted(async (input, init) => { calls.push([input.toString(), JSON.parse(init!.body as string)]); return Response.json(updated); });
  try {
    await act(async () => h.renderer.root.findAllByType("li")[0].findByType("button").props.onClick());
    assert.equal(h.gets(), 1); assert.equal(h.renderer.root.findAllByType("li").length, 1);
    assert.deepEqual(calls, [["/clinical-graph/encounters/e1/follow-up-queue/decisions", { orderable: "photos", focus: "optic nerve", decision: "not-today" }]]);
    assert.equal(h.renderer.root.findByType("button").children.join(""), "Put back");
    await act(async () => h.renderer.root.findByType("button").props.onClick());
    assert.equal((calls[1] as any)[1].decision, "put-back"); assert.equal(h.gets(), 1);
  } finally { await h.close(); }
});

test("S3c2b G15 who and machine-readable when are shown even without permission", async () => {
  const h = await decisionMounted(async () => Response.json(decisionPayload), { ...decisionPayload, canDecide: false });
  try {
    const row = h.renderer.root.findAllByType("li")[1];
    assert.ok(row.findAllByType("p").some(p => p.children.includes("Tech Synthetic")));
    assert.equal(row.findByType("time").props.dateTime, decisionAt);
    assert.match(row.findByType("time").children.join(""), /\d{1,2}:\d{2}/);
    assert.match(text(h.renderer.toJSON()), /The shape will not put it back\./);
  } finally { await h.close(); }
});

test("S3c2b malformed Not today and permission payloads are refused", async () => {
  for (const value of [{ ...decisionPayload, canDecide: "true" }, { ...decisionPayload, rows: [{ ...decisionPayload.rows[1], decidedBy: undefined }] }, { ...decisionPayload, rows: [{ ...decisionPayload.rows[1], decidedAt: undefined }] }]) {
    const h = await decisionMounted(async () => Response.json(value), value);
    try { assert.match(text(h.renderer.toJSON()), /The tests for this visit could not be loaded/); } finally { await h.close(); }
  }
});

const chargePayload = { recorded: true, canDecide: true, canAccept: true, diagnoses: [
  { reference: "Condition/glaucoma", display: "Glaucoma", rank: 1, matches: false },
  { reference: "Condition/macula", display: "Macular drusen", rank: 2, matches: true },
], rows: [
  { orderable: "field", label: "Visual field", state: "for-review", sources: ["from the Glaucoma shape"] },
  { orderable: "photos", focus: "retina", label: "Retina photos", state: "already-ordered", actionIds: ["one"], sources: ["from the Retina shape"], charge: { status: "billed", proposalId: "manual-procedure-charge:one", dxPointer: "Condition/glaucoma", dxDisplay: "Glaucoma" } },
] };

test("S3c2c1b G11 Accept and charge controls require their new permission and charge fields", async () => {
  for (const value of [chargePayload, { ...chargePayload, canAccept: false }, { ...chargePayload, canAccept: undefined, rows: chargePayload.rows.map(row => ({ ...row, charge: undefined })) }]) {
    const h = await mounted(async () => Response.json(value));
    try {
      const labels = h.renderer.root.findAllByType("li").map(row => row.findAllByType("button").map(button => button.children.join("")));
      if (value.canAccept) assert.deepEqual(labels, [["Not today", "Accept"], ["Remove charge", "Change diagnosis"]]);
      else assert.deepEqual(labels, [["Not today"], []]);
    } finally { await h.close(); }
  }
});

test("S3c2c1b G12 Remove and Restore PATCH then re-GET, while duplicate-charge stays row-scoped", async () => {
  const initial = { ...chargePayload, rows: [chargePayload.rows[1], { ...chargePayload.rows[1], orderable: "oct", label: "OCT", charge: { status: "removed", proposalId: "manual-procedure-charge:oct", removedBy: "Tech Synthetic" } }] };
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let current: unknown = initial;
  const h = await mounted(async () => Response.json(current));
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "PATCH" && String(input).endsWith("manual-procedure-charge%3Aoct")) return Response.json({ code: "duplicate-charge", error: "OCT is already charged on this visit." }, { status: 409 });
    if (method === "PATCH") {
      current = { ...initial, rows: [{ ...initial.rows[0], charge: { status: "removed", proposalId: "manual-procedure-charge:one", removedBy: "Tech Synthetic" } }, initial.rows[1]] };
      return Response.json({ proposal: {} });
    }
    return Response.json(current);
  };
  try {
    const rows = h.renderer.root.findAllByType("li");
    await act(async () => rows[0].findAllByType("button").find(button => button.children.join("") === "Remove charge")!.props.onClick());
    assert.deepEqual(calls.slice(0, 2).map(call => [call.method, call.body]), [["PATCH", { state: "removed" }], ["GET", undefined]]);
    await act(async () => h.renderer.root.findAllByType("li")[1].findAllByType("button").find(button => button.children.join("") === "Restore charge")!.props.onClick());
    assert.deepEqual(calls[2].body, { state: "accepted" });
    assert.match(text(h.renderer.root.findAllByType("li")[1].findByProps({ role: "status" }).children), /already charged/);
    assert.equal(h.renderer.root.findAllByProps({ role: "alert" }).length, 0);
  } finally { globalThis.fetch = previous; await h.close(); }
});

test("S3c2c1b G12 Change diagnosis offers matching diagnoses first and PATCHes only the chosen Encounter diagnosis", async () => {
  const calls: unknown[] = [];
  const h = await mounted(async () => Response.json(chargePayload));
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PATCH") calls.push(JSON.parse(String(init.body)));
    return init?.method === "PATCH" ? Response.json({ proposal: {} }) : Response.json(chargePayload);
  };
  try {
    const row = h.renderer.root.findAllByType("li")[1];
    await act(async () => row.findAllByType("button").find(button => button.children.join("") === "Change diagnosis")!.props.onClick());
    const select = h.renderer.root.findByType("select");
    assert.deepEqual(select.findAllByType("option").map(option => option.props.value), ["Condition/macula", "Condition/glaucoma"]);
    assert.equal(select.props.value, "Condition/glaucoma");
    await act(async () => select.props.onChange({ target: { value: "Condition/macula" } }));
    assert.deepEqual(calls, [{ dxPointer: "Condition/macula" }]);
  } finally { globalThis.fetch = previous; await h.close(); }
});
