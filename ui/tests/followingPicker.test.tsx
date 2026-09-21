import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { FollowingPicker } from "../src/components/charting/FollowingPicker";

const previous = { pageSize: 4, encounters: [
  { encounterReference: "Encounter/recent", date: "2026-09-18T12:00:00Z", visitType: "Synthetic", diagnoses: [{ conditionReference: "Condition/recent", display: "Recent problem", identity: { coding: [], laterality: "OU" }, findings: [], checked: false }] },
  { encounterReference: "Encounter/older", date: "2026-09-17T12:00:00Z", visitType: "Synthetic", diagnoses: [{ conditionReference: "Condition/older", display: "Older problem", identity: { coding: [], laterality: "OD" }, findings: [], checked: false }] },
] };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const text = (node: any): string => node.children.map((child: any) => typeof child === "string" ? child : text(child)).join("");

test("S3b2 picker reuses prior reader, offers newest first and applies the chosen template once", async () => {
  const original = globalThis.fetch; const calls: Array<{url: string; method: string}> = []; const picks: unknown[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), method: init?.method ?? "GET" }); return new Response(JSON.stringify(previous)); };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<FollowingPicker encounterReference="Encounter/current" source="derived" busy={false} onPick={async choice => { picks.push(choice); return true; }} />); await flush(); });
    const buttons = renderer.root.findAllByType("button").filter(button => text(button) === "Follow this");
    assert.equal(buttons.length, 2);
    assert.ok(text(renderer.root).indexOf("Recent problem") < text(renderer.root).indexOf("Older problem"));
    await act(async () => { renderer.root.findByProps({ "aria-label": "Follow-up template" }).props.onChange({ target: { value: "comprehensive" } }); });
    await act(async () => { await buttons[0].props.onClick(); });
    assert.deepEqual(picks, [{ examScope: "comprehensive", following: { sourceEncounterReference: "Encounter/recent", sourceConditionReference: "Condition/recent" } }]);
    assert.deepEqual(calls, [{ url: "/clinical-graph/encounters/current/previous-exams", method: "GET" }]);
  } finally { if (renderer) act(() => renderer.unmount()); globalThis.fetch = original; }
});

test("S3b2 Nothing to follow chooses office with no prior, and explicit permits deliberate re-pick", async () => {
  const original = globalThis.fetch; const picks: unknown[] = []; let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify(previous)); };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<FollowingPicker encounterReference="Encounter/current" source="explicit" busy={false} onPick={async choice => { picks.push(choice); return true; }} />); await flush(); });
    assert.equal(requests, 0);
    await act(async () => { renderer.root.findByProps({ "data-testid": "change-following" }).props.onClick(); await flush(); });
    assert.equal(requests, 1);
    await act(async () => { renderer.root.findByProps({ "aria-label": "Follow-up template" }).props.onChange({ target: { value: "comprehensive" } }); });
    await act(async () => { await renderer.root.findByProps({ "data-testid": "nothing-to-follow" }).props.onClick(); });
    assert.deepEqual(picks, [{ examScope: "office-visit", following: null }]);
  } finally { if (renderer) act(() => renderer.unmount()); globalThis.fetch = original; }
});

test("S3b2 G6 picker and projection never infer scope from scheduling", () => {
  for (const path of ["../src/components/charting/FollowingPicker.tsx", "../../mcp/src/clinical-graph/exam-overview-projection.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /appointment|Appointment|resolveVisitTypeCategory|visitTypeCategoryId/);
  }
});


for (const kind of ["failed", "unrecognized"] as const) {
  test(`S3b2 G9b ${kind} history visibly fails inside picker while template and Nothing to follow work`, async () => {
    const original = globalThis.fetch; const picks: unknown[] = [];
    globalThis.fetch = async () => kind === "failed"
      ? new Response(JSON.stringify({ error: "Synthetic history read failed" }), { status: 503 })
      : new Response(JSON.stringify({ resourceType: "Bundle", entry: [] }));
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<FollowingPicker encounterReference="Encounter/current" source="derived" busy={false} onPick={async choice => { picks.push(choice); return true; }} />); await flush(); });
      const picker = renderer.root.findByProps({ "aria-label": "What are we following?" });
      assert.match(text(picker), /Previous exams could not be loaded/);
      const failure = picker.findByProps({ role: "status" });
      assert.match(text(failure), /Previous exams could not be loaded/);
      assert.doesNotMatch(text(picker), /No previous exams\./);
      assert.equal(failure.props.hidden, undefined);
      assert.equal(failure.props["aria-hidden"], undefined);
      const template = picker.findByProps({ "aria-label": "Follow-up template" });
      assert.equal(template.props.disabled, false);
      await act(async () => { template.props.onChange({ target: { value: "comprehensive" } }); });
      assert.equal(picker.findByProps({ "aria-label": "Follow-up template" }).props.value, "comprehensive");
      const nothing = picker.findByProps({ "data-testid": "nothing-to-follow" });
      assert.equal(nothing.props.disabled, false);
      await act(async () => { await nothing.props.onClick(); });
      assert.deepEqual(picks, [{ examScope: "office-visit", following: null }]);
    } finally { if (renderer) act(() => renderer.unmount()); globalThis.fetch = original; }
  });
}
