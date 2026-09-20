import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { FollowUpProfilesSettings } from "../src/components/settings/FollowUpProfilesSettings";
import { FOLLOW_UP_PROFILE_SEEDS } from "../../mcp/src/clinical-graph/follow-up-profile-store";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const seed = structuredClone(FOLLOW_UP_PROFILE_SEEDS[0]!);
function catalog(canWrite = true) {
  return { canWrite, profiles: [{ ...seed, versionId: "7" }], shipped: [seed], choices: {
    sectionsOpen: [...seed.sectionsOpen, { key: "cover-test", label: "Cover Test" }],
    testsQueuedByDefault: seed.testsQueuedByDefault, priorValuesShown: seed.priorValuesShown,
    historyItems: seed.historyItems, matchesDiagnosisFamilies: seed.matchesDiagnosisFamilies,
  } };
}

test("Settings picker adds a real section and saves the caller version without changing shipped data", async () => {
  const originalFetch = globalThis.fetch;
  const writes: any[] = [];
  globalThis.fetch = async (_url, init) => { if (init?.method === "POST") writes.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(init?.method === "POST" ? {} : catalog()), { status: 200 }); };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<FollowUpProfilesSettings />); });
    await act(async () => renderer.root.findByProps({ "aria-label": `Open profile ${seed.label}` }).props.onClick());
    assert.equal(renderer.root.findAllByType("fieldset").length, 5);
    await act(async () => renderer.root.findByProps({ "aria-label": "Add Opens" }).props.onChange({ target: { value: "cover-test" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].expectedVersion, "7");
    assert.ok(writes[0].profile.sectionsOpen.some((r: { key: string }) => r.key === "cover-test"));
    assert.deepEqual(seed, FOLLOW_UP_PROFILE_SEEDS[0]);
  } finally { act(() => renderer?.unmount()); globalThis.fetch = originalFetch; }
});

test("Settings read-only catalogue permits inspection but no save controls or writes", async () => {
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (_url, init) => { if (init?.method === "POST") writes++; return new Response(JSON.stringify(catalog(false))); };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<FollowUpProfilesSettings />); });
    await act(async () => renderer.root.findByProps({ "aria-label": `Open profile ${seed.label}` }).props.onClick());
    assert.ok(renderer.root.findAllByType("fieldset").every(f => f.props.disabled));
    assert.equal(renderer.root.findAllByProps({ type: "submit" }).length, 0);
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    assert.equal(writes, 0);
  } finally { act(() => renderer?.unmount()); globalThis.fetch = originalFetch; }
});

test("Settings reset carries the current version and conflict leaves the edit intact", async () => {
  const originalFetch = globalThis.fetch;
  const writes: any[] = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ error: "Concurrent edit", code: "concurrent-edit" }), { status: 409 }); }
    return new Response(JSON.stringify(catalog()));
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<FollowUpProfilesSettings />); });
    await act(async () => renderer.root.findByProps({ "aria-label": `Open profile ${seed.label}` }).props.onClick());
    await act(async () => renderer.root.findByProps({ "aria-label": "Reset to shipped" }).props.onClick());
    assert.deepEqual(writes[0], { action: "reset", expectedVersion: "7" });
    assert.equal(renderer.root.findAllByType("form").length, 1);
    assert.ok(renderer.root.findByProps({ role: "alert" }));
  } finally { act(() => renderer?.unmount()); globalThis.fetch = originalFetch; }
});
