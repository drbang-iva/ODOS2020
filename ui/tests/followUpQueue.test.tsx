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
