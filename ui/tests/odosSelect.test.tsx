import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { OdosSelect } from "../src/components/inputs/OdosSelect";

test("OdosSelect opens at its current value and supports Home, End, and Escape without selection", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalDocument = globalThis.document;
  let selected: string | undefined;
  let centered = false;
  let renderer: ReactTestRenderer | undefined;
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 1; };
  globalThis.cancelAnimationFrame = () => undefined;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { addEventListener: () => undefined, removeEventListener: () => undefined },
  });
  try {
    act(() => {
      renderer = create(
        <OdosSelect
          value="beta"
          defaultValue="alpha"
          options={[
            { value: "alpha", label: "Alpha" },
            { value: "beta", label: "Beta" },
            { value: "gamma", label: "Gamma" },
          ]}
          onChange={(value) => { selected = value; }}
          ariaLabel="Example value"
        />,
        {
          createNodeMock: (element) => element.props.id?.endsWith("-option-1")
            ? { scrollIntoView: () => { centered = true; } }
            : {},
        },
      );
    });
    const combobox = () => renderer!.root.findByProps({ role: "combobox" });
    act(() => combobox().props.onClick());
    assert.equal(centered, true);
    assert.match(combobox().props["aria-activedescendant"], /-option-1$/);

    act(() => combobox().props.onKeyDown(key("End")));
    assert.match(renderer!.root.findByProps({ role: "combobox" }).props["aria-activedescendant"], /-option-2$/);
    act(() => combobox().props.onKeyDown(key("Home")));
    assert.match(renderer!.root.findByProps({ role: "combobox" }).props["aria-activedescendant"], /-option-0$/);
    act(() => combobox().props.onKeyDown(key("Escape")));
    assert.equal(renderer!.root.findByProps({ role: "listbox" }).props.hidden, true);
    assert.equal(selected, undefined);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("OdosSelect renders grouped options, fixed states, and 44px targets with 8px gaps", () => {
  const html = renderToStaticMarkup(
    <OdosSelect
      value="not-recorded"
      defaultValue="manual"
      states={[{ value: "not-recorded", label: "Not recorded" }]}
      options={[
        { value: "manual", label: "Manual", group: "Clinical" },
        { value: "auto", label: "Auto", group: "Instrument" },
      ]}
      onChange={() => undefined}
      ariaLabel="Method"
    />,
  );

  assert.match(html, /role="separator"[^>]*aria-hidden="true"[^>]*>Clinical/);
  assert.match(html, /role="separator"[^>]*aria-hidden="true"[^>]*>Instrument/);
  assert.match(html, /Not recorded/);
  assert.match(html, /min-h-11/);
  assert.match(html, /space-y-2/);
  assert.match(html, /gap-2/);
  assert.doesNotMatch(html, /--odos-/);
});

function key(value: string) {
  return {
    key: value,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => undefined,
  };
}
