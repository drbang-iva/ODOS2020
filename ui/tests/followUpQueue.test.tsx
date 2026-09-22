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

test("S3c2c1b G12 stale charge diagnosis shows no selected visit diagnosis", async () => {
  const stale = { ...chargePayload, rows: [chargePayload.rows[0], {
    ...chargePayload.rows[1], charge: { ...chargePayload.rows[1].charge, dxPointer: "Condition/historical" },
  }] };
  const h = await mounted(async () => Response.json(stale));
  try {
    const row = h.renderer.root.findAllByType("li")[1];
    await act(async () => row.findAllByType("button").find(button => button.children.join("") === "Change diagnosis")!.props.onClick());
    const select = h.renderer.root.findByType("select");
    assert.equal(select.props.value, "");
    assert.deepEqual(select.findAllByType("option").map(option => option.props.value), ["", "Condition/macula", "Condition/glaucoma"]);
  } finally { await h.close(); }
});

test("S3c2c2a1 G14 read-only result facts render without mutation buttons (amended S3c2c2a2 R2)", async () => {
  const baseline = { ...decisionPayload, rows: [
    { ...decisionPayload.rows[0] },
    { ...decisionPayload.rows[2] },
  ] };
  const augmented = { ...baseline, rows: [
    { ...baseline.rows[0], unreviewedResult: true },
    { ...baseline.rows[1], result: {
      status: "needs-interpretation", items: [{ mediaReference: "Media/photo-1", title: "synthetic.jpg", date: "2026-09-21T15:00:00Z" }], candidates: [],
    } },
  ] };
  const plain = await mounted(async () => Response.json(baseline));
  let expected: unknown;
  try { expected = text(plain.renderer.toJSON()); } finally { await plain.close(); }
  const linked = await mounted(async () => Response.json(augmented));
  try {
    assert.doesNotMatch(String(expected), /Completed — needs interpretation|Done — not reviewed/);
    assert.match(text(linked.renderer.toJSON()), /Completed — needs interpretation/);
    assert.match(text(linked.renderer.toJSON()), /Done — not reviewed/);
    assert.equal(linked.renderer.root.findAllByType("input").length, 0);
    assert.equal(linked.renderer.root.findAllByType("li").length, 2);
    assert.deepEqual(linked.renderer.root.findAllByType("li").map(row => row.findAllByType("button").map(button => button.children.join(""))), [["Not today"], []]);
  } finally { await linked.close(); }
});

const imagingResult = { status: "needs-interpretation", orderReference: "ServiceRequest/vf-1", category: "visual-field",
  items: [{ mediaReference: "Media/vf-1", title: "field.jpg", date: "2026-09-21T15:00:00Z" }],
  candidates: [{ mediaReference: "Media/candidate", title: "candidate.pdf", date: "2026-09-21T15:01:00Z" }] };
const imagingPayload = { recorded: true, canDecide: true, canAccept: true, rows: [
  { orderable: "visual-field-threshold", label: "Visual field", sources: [], state: "already-ordered", actionIds: ["vf-1"], result: imagingResult },
  { orderable: "fundus-photography", focus: "optic nerve", label: "Optic nerve photos", sources: [], state: "for-review", unreviewedResult: true },
] };
async function resultMounted(reply: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, element?: React.ReactElement) {
  const previous = globalThis.fetch;
  globalThis.fetch = reply;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(element ?? <FollowUpQueue encounterId="e1" active patientReference="Patient/p1" onOpenImaging={() => undefined} />); });
  return { renderer, async close() { await act(async () => renderer.unmount()); globalThis.fetch = previous; } };
}
function resultButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find(button => button.children.join("") === label)!;
}

test("S3c2c2a2 G6 two chosen files capture the row's order and category then refresh once", async () => {
  const calls: Array<{ url: string; method: string; body?: any; headers?: HeadersInit }> = [];
  const h = await resultMounted(async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: init?.headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(init?.method === "POST" ? { mediaReference: "Media/created" } : imagingPayload);
  });
  try {
    const input = h.renderer.root.findByType("input");
    assert.equal(input.props.multiple, true);
    assert.equal(input.props.accept, ".jpg,.jpeg,.png,.webp,.pdf");
    await act(async () => input.props.onChange({ currentTarget: { files: [new File(["jpeg-data"], "field.jpg", { type: "image/jpeg" }), new File(["pdf-data"], "field.pdf", { type: "application/pdf" })], value: "selected" } }));
    assert.deepEqual(calls.map(call => call.method), ["GET", "POST", "POST", "GET"]);
    for (const [index, call] of calls.slice(1, 3).entries()) {
      assert.equal(call.url, "/clinical-graph/imaging");
      assert.equal(new Headers(call.headers).get("Content-Type"), "application/vnd.odos.manual-imaging+json");
      assert.deepEqual(call.body, { patientReference: "Patient/p1", encounterReference: "Encounter/e1", basedOnReference: "ServiceRequest/vf-1", category: "visual-field",
        file: { name: index ? "field.pdf" : "field.jpg", contentType: index ? "application/pdf" : "image/jpeg", data: Buffer.from(index ? "pdf-data" : "jpeg-data").toString("base64") } });
    }
  } finally { await h.close(); }
});

test("S3c2c2a2 G7 completion labels preserve the unreviewed row's working Accept", async () => {
  for (const status of ["needs-interpretation", "interpreted"]) {
    const initial = { ...imagingPayload, rows: [{ ...imagingPayload.rows[0], result: { ...imagingResult, status } }, imagingPayload.rows[1]] };
    let accepted = false;
    const h = await resultMounted(async (input, init) => {
      if (init?.method === "POST") {
        assert.equal(String(input), "/clinical-graph/encounters/e1/follow-up-queue/accept");
        assert.deepEqual(JSON.parse(String(init.body)), { orderable: "fundus-photography", focus: "optic nerve" });
        accepted = true;
        return Response.json({ ...initial, rows: [initial.rows[0], { ...initial.rows[1], state: "already-ordered", actionIds: ["new-order"] }] });
      }
      return Response.json(initial);
    });
    try {
      const view = text(h.renderer.toJSON());
      assert.ok(view.includes(status === "interpreted" ? "Interpreted" : "Completed — needs interpretation"));
      assert.ok(view.includes("Done — not reviewed"));
      assert.ok(resultButton(h.renderer, "Accept"));
      await act(async () => resultButton(h.renderer, "Accept").props.onClick());
      assert.equal(accepted, true);
      assert.equal(resultButton(h.renderer, "Accept"), undefined);
    } finally { await h.close(); }
  }
});

test("S3c2c2a2 G8 committed link acknowledgement reloads successfully; unlink sends its row", async () => {
  for (const action of ["link", "unlink"]) {
    let gets = 0;
    const h = await resultMounted(async (input, init) => {
      if (init?.method === "POST") {
        assert.equal(String(input), "/clinical-graph/encounters/e1/follow-up-queue/results");
        assert.deepEqual(JSON.parse(String(init.body)), { orderable: "visual-field-threshold", mediaReference: action === "link" ? "Media/candidate" : "Media/vf-1", action });
        return Response.json({ committed: true, reloadRequired: true });
      }
      gets++;
      return Response.json(imagingPayload);
    });
    try {
      await act(async () => resultButton(h.renderer, action === "link" ? "Link" : "Unlink").props.onClick());
      assert.equal(gets, 2);
      assert.equal(h.renderer.root.findAllByProps({ role: "status" }).length, 0);
    } finally { await h.close(); }
  }
});

test("S3c2c2a2 G9 read-only rows retain facts without Record Link Unlink or View controls", async () => {
  for (const canAccept of [false, undefined]) {
    const h = await resultMounted(async () => Response.json({ ...imagingPayload, canAccept }));
    try {
      const view = text(h.renderer.toJSON());
      assert.match(view, /Completed — needs interpretation/);
      assert.match(view, /Done — not reviewed/);
      assert.equal(h.renderer.root.findAllByType("input").length, 0);
      for (const label of ["Record result", "Link", "Unlink", "View in Imaging"]) assert.equal(resultButton(h.renderer, label), undefined);
      assert.ok(resultButton(h.renderer, "Not today"));
    } finally { await h.close(); }
  }
});

test("S3c2c2a2 G10 the production EncounterCharting callback selects the Imaging tab", async () => {
  const { readFileSync } = await import("node:fs");
  const ts = await import("typescript");
  const { selectExamRightPanelTab } = await import("../src/components/charting/ExamRightPanel");
  const source = readFileSync(new URL("../src/scenes/EncounterCharting.tsx", import.meta.url), "utf8");
  const jsx = source.match(/<FollowUpQueue\b[\s\S]*?\/>/)?.[0];
  assert.ok(jsx);
  const compiled = ts.transpileModule(`const element = ${jsx};`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  let panel = { activeTab: "follow-up", returnTab: "images", summoned: false };
  const element = new Function("React", "FollowUpQueue", "encounterId", "patientReference", "rightPanelState", "setRightPanelState", "selectExamRightPanelTab", `${compiled}; return element;`)(
    React, FollowUpQueue, "e1", "Patient/p1", panel, (change: any) => { panel = change(panel); }, selectExamRightPanelTab);
  const h = await resultMounted(async () => Response.json(imagingPayload), element);
  try {
    assert.equal(h.renderer.root.findByType(FollowUpQueue).props.patientReference, "Patient/p1");
    await act(async () => resultButton(h.renderer, "View in Imaging").props.onClick());
    assert.equal(panel.activeTab, "imaging");
    assert.equal(panel.summoned, true);
  } finally { await h.close(); }
});

test("S3c2c2a2 G11 malformed result and review hint fail the load closed", async () => {
  for (const row of [
    { ...imagingPayload.rows[0], result: { ...imagingResult, status: "complete" } },
    { ...imagingPayload.rows[0], result: { ...imagingResult, items: [{ ...imagingResult.items[0], mediaReference: 42 }] } },
    { ...imagingPayload.rows[0], result: { ...imagingResult, category: 42 } },
    { ...imagingPayload.rows[0], result: { ...imagingResult, orderReference: "Patient/wrong" } },
    { ...imagingPayload.rows[1], unreviewedResult: "true" },
  ]) {
    const h = await resultMounted(async () => Response.json({ ...imagingPayload, rows: [row] }));
    try { assert.match(text(h.renderer.toJSON()), /The tests for this visit could not be loaded/); }
    finally { await h.close(); }
  }
});

test("S3c2c2a2 upload refusal is visible only in its row and saving blocks that row", async () => {
  let refuse!: (response: Response) => void;
  const h = await resultMounted(async (_input, init) => init?.method === "POST" ? new Promise(resolve => { refuse = resolve; }) : Response.json(imagingPayload));
  try {
    let saved!: Promise<void>;
    await act(async () => { saved = h.renderer.root.findByType("input").props.onChange({ currentTarget: { files: [new File(["jpeg"], "field.jpg", { type: "image/jpeg" })], value: "selected" } }); });
    assert.equal(h.renderer.root.findByType("input").props.disabled, true);
    assert.equal(resultButton(h.renderer, "Link").props.disabled, true);
    assert.equal(resultButton(h.renderer, "Accept").props.disabled, false);
    await act(async () => { refuse(Response.json({ error: "Binary create is forbidden for this caller." }, { status: 403 })); await saved; });
    const rows = h.renderer.root.findAllByType("li");
    assert.equal(rows[0].findByProps({ role: "status" }).children.join(""), "Binary create is forbidden for this caller.");
    assert.equal(rows[1].findAllByProps({ role: "status" }).length, 0);
    assert.equal(h.renderer.root.findByType("input").props.disabled, false);
  } finally { await h.close(); }
});

test("S3c2c2b1 G7 interpretation control stays on result row, prefills, validates, saves and shows row error", async () => {
  const opticRow = { orderable: "fundus-photography", focus: "optic nerve", label: "Optic nerve photos",
    sources: [], state: "already-ordered", actionIds: ["optic"], result: { ...imagingResult, status: "none", items: [], candidates: [] } };
  const retinaRow = { orderable: "fundus-photography", focus: "retina", label: "Retina photos",
    sources: [], state: "already-ordered", actionIds: ["retina"],
    result: { ...imagingResult, category: "fundus-photo", draftConclusion: "Draft read" } };
  const fieldRow = { ...imagingPayload.rows[0], result: { ...imagingResult, status: "interpreted" } };
  const initial = { recorded: true, canDecide: true, canAccept: true, rows: [opticRow, retinaRow, fieldRow] };
  const after = { ...initial, rows: [
    { ...opticRow, result: { ...opticRow.result, status: "interpreted" } },
    { ...retinaRow, result: { ...retinaRow.result, status: "interpreted" } }, fieldRow,
  ] };
  let refused = true;
  const posted: unknown[] = [];
  const h = await resultMounted(async (_input, init) => {
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return refused
        ? Response.json({ code: "interpretation-requires-signer", error: "Only a doctor can save an interpretation." }, { status: 403 })
        : Response.json(after);
    }
    return Response.json(initial);
  });
  try {
    const rows = h.renderer.root.findAllByType("li");
    assert.equal(rows[0].findAllByType("button").some(button => button.children.join("") === "Add interpretation"), false);
    assert.equal(rows[1].findAllByType("button").some(button => button.children.join("") === "Add interpretation"), true);
    assert.equal(rows[2].findAllByType("button").some(button => button.children.join("") === "Add interpretation"), false);
    await act(async () => resultButton(h.renderer, "Add interpretation").props.onClick());
    const textarea = h.renderer.root.findByProps({ "aria-label": "Interpretation" });
    assert.equal(textarea.props.value, "Draft read");
    assert.equal(textarea.props.maxLength, 5000);
    await act(async () => textarea.props.onChange({ target: { value: "   " } }));
    assert.equal(resultButton(h.renderer, "Save").props.disabled, true);
    await act(async () => h.renderer.root.findByProps({ "aria-label": "Interpretation" }).props.onChange({ target: { value: "  Reviewed  " } }));
    assert.equal(resultButton(h.renderer, "Save").props.disabled, false);
    await act(async () => resultButton(h.renderer, "Save").props.onClick());
    assert.deepEqual(posted[0], { action: "interpret", orderable: "fundus-photography", focus: "retina", conclusion: "Reviewed" });
    assert.match(rows[1].findByProps({ role: "status" }).children.join(""), /Only a doctor can save an interpretation/);
    assert.equal(rows[0].findAllByProps({ role: "status" }).length, 0);
    refused = false;
    await act(async () => resultButton(h.renderer, "Save").props.onClick());
    assert.equal(h.renderer.root.findAllByType("button").some(button => button.children.join("") === "Add interpretation"), false);
    assert.match(text(h.renderer.toJSON()), /Interpreted/);
  } finally { await h.close(); }
  const readOnly = await resultMounted(async () => Response.json({ ...initial, canAccept: false }));
  try { assert.equal(resultButton(readOnly.renderer, "Add interpretation"), undefined); }
  finally { await readOnly.close(); }
});

test("S3c2c2b1 G8 non-string draft conclusion fails the queue load closed", async () => {
  const malformed = { ...imagingPayload, rows: [{ ...imagingPayload.rows[0], result: { ...imagingResult, draftConclusion: 42 } }] };
  const h = await resultMounted(async () => Response.json(malformed));
  try { assert.match(text(h.renderer.toJSON()), /The tests for this visit could not be loaded/); }
  finally { await h.close(); }
});

test("S3c2c2b1 G14 an old encounter's completed save cannot clear the new encounter's draft", async () => {
  let resolveSave!: (response: Response) => void;
  const h = await resultMounted(async (_input, init) => init?.method === "POST"
    ? new Promise<Response>(resolve => { resolveSave = resolve; })
    : Response.json(imagingPayload));
  try {
    await act(async () => resultButton(h.renderer, "Add interpretation").props.onClick());
    await act(async () => h.renderer.root.findByProps({ "aria-label": "Interpretation" }).props.onChange({ target: { value: "Old encounter draft" } }));
    let oldSave!: Promise<void>;
    await act(async () => { oldSave = resultButton(h.renderer, "Save").props.onClick(); });

    await act(async () => h.renderer.update(<FollowUpQueue encounterId="e2" active patientReference="Patient/p1" onOpenImaging={() => undefined} />));
    await act(async () => resultButton(h.renderer, "Add interpretation").props.onClick());
    await act(async () => h.renderer.root.findByProps({ "aria-label": "Interpretation" }).props.onChange({ target: { value: "New encounter draft" } }));

    await act(async () => { resolveSave(Response.json(imagingPayload)); await oldSave; });
    assert.equal(h.renderer.root.findByProps({ "aria-label": "Interpretation" }).props.value, "New encounter draft");
  } finally { await h.close(); }
});
