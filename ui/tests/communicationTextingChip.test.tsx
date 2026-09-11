import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PatientOverview } from "../src/scenes/PatientOverview";
for (const [name, global, numbers, failed, expected] of [
  ["global", true, [], false, true],
  ["per-number", false, ["+15555550101"], false, true],
  ["clear", false, [], false, false],
  ["unavailable", false, [], true, false],
] as const) test(`M13 chart Texting blocked chip ${name}`, async () => {
  const original = globalThis.fetch;
  let renderer!: ReactTestRenderer;
  let optOutReads = 0;
  globalThis.fetch = async url => {
    if (String(url).startsWith("/communications/opt-out?")) {
      optOutReads += 1;
      return new Response(JSON.stringify({ patientReference: "Patient/synthetic-chip", smsOptedOut: global || numbers.length > 0, remainingOptOuts: { global, numbers }, smsLanes: [] }), { status: failed ? 500 : 200 });
    }
    return new Response(JSON.stringify({ error: "Unavailable in synthetic fixture" }), { status: 403 });
  };
  try {
    await act(async () => { renderer = create(<PatientOverview patient={{ resourceType: "Patient", id: "synthetic-chip", name: [{ given: ["Synthetic"], family: "Chip" }] }} onPatientSaved={() => {}} />); });
    assert.ok(optOutReads > 0);
    assert.equal(renderer.root.findAllByType("span").some(n => n.children.join("") === "Texting blocked (STOP)"), expected);
  } finally { act(() => renderer?.unmount()); globalThis.fetch = original; }
});
