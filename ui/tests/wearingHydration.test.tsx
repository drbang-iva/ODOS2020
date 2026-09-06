import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { WearingSection } from "../src/components/charting/WearingSection";

const savedPair = {
  id: "synthetic-wearing-pair", eyeglassType: "single_vision_distance", remarks: "Synthetic saved glasses",
  OD: { sphere: -2, cylinder: -0.5, axis: 180, add: 1, prismAmount: 0.5, prismBase: "in", distanceVisualAcuity: "20/20" },
  OS: { sphere: -1.75 },
};
const definition = { definition: { fields: {
  eyeglassType: { options: [{ code: "single_vision_distance", display: "Single Vision Distance" }] },
  sourceType: { options: [{ code: "manual", display: "Manual" }] },
  prismBase: { options: [{ code: "in", display: "In" }] },
} } };

async function mounted(history: () => Promise<Response>, check: (renderer: ReactTestRenderer, writes: unknown[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const writes: unknown[] = [];
  let renderer: ReactTestRenderer | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/wearing/definition")) return Response.json(definition);
    if (url.includes("/wearing/history")) return history();
    if (init?.method === "POST" && url.endsWith("/wearing")) {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({ pairs: [savedPair] });
    }
    return Response.json({ entries: [] });
  };
  try {
    await act(async () => { renderer = create(<WearingSection patientReference="Patient/synthetic" encounterReference="Encounter/synthetic" onSaved={() => undefined} />); });
    await check(renderer!, writes);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    globalThis.fetch = originalFetch;
  }
}
function value(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByProps({ "aria-label": label }).find((node) => node.type === "input" || node.type === "button")!.props.value;
}
function saveButton(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("button").find((node) => /^(Save Wearing|Saving\.\.\.)$/.test(node.children.join("")))!;
}

test("P2 Wearing reopens every saved optical field and an unchanged Save creates no duplicate", async () => {
  await mounted(async () => Response.json({ pairs: [savedPair], leftGlassesAtHome: false }), async (renderer, writes) => {
    assert.equal(value(renderer, "OD sphere"), "-2.00");
    assert.equal(value(renderer, "OD cylinder"), "-0.50");
    assert.equal(value(renderer, "OD axis"), "180");
    assert.equal(value(renderer, "OD add"), "1.00");
    assert.equal(value(renderer, "OD prism amount"), "0.50");
    assert.equal(value(renderer, "OS sphere"), "-1.75");
    assert.equal(value(renderer, "OS cylinder"), "");
    assert.match(JSON.stringify(renderer.toJSON()), /Synthetic saved glasses/);
    await act(async () => { await saveButton(renderer).props.onClick(); });
    assert.deepEqual(writes, []);
  });
});

test("P2 a genuinely empty Wearing form refuses Save without any persistence request", async () => {
  await mounted(async () => Response.json({ pairs: [], leftGlassesAtHome: false }), async (renderer, writes) => {
    await act(async () => { await saveButton(renderer).props.onClick(); });
    assert.deepEqual(writes, []);
    assert.match(JSON.stringify(renderer.toJSON()), /requires at least one populated eye/);
  });
});

test("P2 history loading and read failure cannot turn missing values into a writable blank form", async () => {
  let finish!: (value: Response) => void;
  await mounted(() => new Promise((resolve) => { finish = resolve; }), async (renderer, writes) => {
    assert.equal(saveButton(renderer).props.disabled, true);
    await act(async () => { finish(Response.json({ error: "Synthetic history unavailable" }, { status: 503 })); });
    assert.equal(saveButton(renderer).props.disabled, true);
    assert.match(JSON.stringify(renderer.toJSON()), /Synthetic history unavailable/);
    assert.deepEqual(writes, []);
  });
});

test("P2 a late previous-encounter response cannot replace the new encounter's Wearing values", async () => {
  let finish!: (value: Response) => void;
  let request = 0;
  await mounted(() => ++request === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(Response.json({ pairs: [{ ...savedPair, OD: { sphere: -3 } }] })), async (renderer) => {
    await act(async () => { renderer.update(<WearingSection patientReference="Patient/next" encounterReference="Encounter/next" onSaved={() => undefined} />); });
    assert.equal(value(renderer, "OD sphere"), "-3.00");
    await act(async () => { finish(Response.json({ pairs: [savedPair] })); });
    assert.equal(value(renderer, "OD sphere"), "-3.00");
  });
});
