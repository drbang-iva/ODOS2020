import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PowerDropdown } from "../src/components/charting/PowerDropdown";
import { RefractionSection } from "../src/components/charting/RefractionSection";
import { OdosSelect } from "../src/components/inputs/OdosSelect";

const PROPS = {
  patientReference: "Patient/synthetic",
  encounterReference: "Encounter/current",
  onSaved: () => undefined,
};

test("prism is off by default and renders no prism inputs", async () => {
  const harness = await renderRefraction();
  try {
    const toggles = prismToggles(harness.renderer);
    assert.equal(toggles.length, 2);
    assert.equal(toggles.every((toggle) => toggle.props["aria-checked"] === false), true);
    assert.equal(prismAmounts(harness.renderer).length, 0);
    assert.equal(prismBases(harness.renderer).length, 0);
  } finally {
    harness.restore();
  }
});

test("each block toggle reveals definition-driven prism inputs for both eyes on the 0.25 to 20.00 scale", async () => {
  const harness = await renderRefraction();
  try {
    act(() => prismToggles(harness.renderer)[0]!.props.onClick());

    const amounts = prismAmounts(harness.renderer);
    assert.deepEqual(amounts.map((input) => input.props.ariaLabel), ["OD prism amount", "OS prism amount"]);
    assert.equal(amounts[0]!.props.options.length, 80);
    assert.deepEqual(amounts[0]!.props.options.slice(0, 3), ["0.25", "0.50", "0.75"]);
    assert.deepEqual(amounts[0]!.props.options.slice(-3), ["19.50", "19.75", "20.00"]);

    const bases = prismBases(harness.renderer);
    assert.deepEqual(bases.map((input) => input.props.ariaLabel), ["OD prism base", "OS prism base"]);
    assert.deepEqual(bases[0]!.props.options.map((option: { value: string }) => option.value), ["", "up", "down", "in", "out"]);
  } finally {
    harness.restore();
  }
});

test("turning prism off clears both eyes and omits prism from the saved payload", async () => {
  const harness = await renderRefraction();
  try {
    act(() => prismToggles(harness.renderer)[0]!.props.onClick());
    act(() => {
      findPower(harness.renderer, "OD sphere", 0).props.onChange("-1.00");
      findPower(harness.renderer, "OS sphere", 0).props.onChange("-1.25");
      findPower(harness.renderer, "OD prism amount", 0).props.onChange("2.00");
      findPower(harness.renderer, "OS prism amount", 0).props.onChange("1.50");
      findSelect(harness.renderer, "OD prism base", 0).props.onChange("in");
      findSelect(harness.renderer, "OS prism base", 0).props.onChange("out");
    });
    act(() => prismToggles(harness.renderer)[0]!.props.onClick());

    const save = harness.renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Save Refraction");
    assert.ok(save);
    await act(async () => {
      await save.props.onClick();
      await Promise.resolve();
    });

    const blocks = harness.savedBodies[0]!.blocks as Array<Record<string, unknown>>;
    assert.deepEqual(blocks[0]!.OD, { sphere: -1 });
    assert.deepEqual(blocks[0]!.OS, { sphere: -1.25 });
  } finally {
    harness.restore();
  }
});

test("Manifest and Final Rx prism toggles remain independent", async () => {
  const harness = await renderRefraction();
  try {
    act(() => prismToggles(harness.renderer)[0]!.props.onClick());
    let toggles = prismToggles(harness.renderer);
    assert.deepEqual(toggles.map((toggle) => toggle.props["aria-checked"]), [true, false]);

    act(() => toggles[1]!.props.onClick());
    toggles = prismToggles(harness.renderer);
    assert.deepEqual(toggles.map((toggle) => toggle.props["aria-checked"]), [true, true]);

    act(() => toggles[0]!.props.onClick());
    assert.deepEqual(prismToggles(harness.renderer).map((toggle) => toggle.props["aria-checked"]), [false, true]);
  } finally {
    harness.restore();
  }
});

async function renderRefraction() {
  const originalFetch = globalThis.fetch;
  const savedBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/refraction/definition")) return Response.json(refractionDefinition());
    if (url.includes("/clinical-graph/refraction/history?")) {
      return Response.json({ glasses: [], softCl: [], specialtyCl: [] });
    }
    if (url.endsWith("/clinical-graph/refraction") && init?.method === "POST") {
      savedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ blocks: [{ eyes: { OD: {}, OS: {} } }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<RefractionSection {...PROPS} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    renderer: renderer!,
    savedBodies,
    restore() {
      renderer?.unmount();
      globalThis.fetch = originalFetch;
    },
  };
}

function prismToggles(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("button").filter((button) => button.props.role === "switch");
}

function prismAmounts(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType(PowerDropdown).filter((input) => input.props.ariaLabel.endsWith("prism amount"));
}

function prismBases(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType(OdosSelect).filter((input) => input.props.ariaLabel.endsWith("prism base"));
}

function findPower(renderer: ReactTestRenderer, ariaLabel: string, index: number) {
  return renderer.root.findAllByType(PowerDropdown).filter((input) => input.props.ariaLabel === ariaLabel)[index]!;
}

function findSelect(renderer: ReactTestRenderer, ariaLabel: string, index: number) {
  return renderer.root.findAllByType(OdosSelect).filter((input) => input.props.ariaLabel === ariaLabel)[index]!;
}

function refractionDefinition() {
  return {
    definition: {
      fields: {
        type: { options: [
          { code: "MANIFEST", display: "Manifest", active: true },
          { code: "FINAL_RX", display: "Final/Rx", active: true },
        ] },
        sourceType: { options: [{ code: "manual", display: "Manual", active: true }] },
        sphere: { minimum: -20, maximum: 20, step: 0.25 },
        axis: { minimum: 0, maximum: 180, step: 1 },
        prismAmount: { minimum: 0.25, maximum: 20, step: 0.25 },
        prismBase: { options: [
          { code: "up", display: "Up", active: true },
          { code: "down", display: "Down", active: true },
          { code: "in", display: "In", active: true },
          { code: "out", display: "Out", active: true },
          { code: "retired", display: "Retired", active: false },
        ] },
      },
    },
    diagnosisOptions: [],
    refractiveThreshold: 0.25,
  };
}
