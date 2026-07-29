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
  const renderSelect = () => (
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
    />
  );
  const assertActive = (suffix: RegExp) => {
    const activeDescendant = renderer!.root.findByProps({ role: "combobox" })
      .props["aria-activedescendant"];
    assert.equal(typeof activeDescendant, "string");
    assert.match(activeDescendant, suffix);
  };
  try {
    act(() => {
      renderer = create(
        renderSelect(),
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
    assertActive(/-option-1$/);

    act(() => combobox().props.onKeyDown(key("End")));
    assertActive(/-option-2$/);
    act(() => renderer!.update(renderSelect()));
    assertActive(/-option-2$/);
    act(() => combobox().props.onKeyDown(key("Home")));
    assertActive(/-option-0$/);
    act(() => combobox().props.onKeyDown(key("Escape")));
    assert.equal(renderer!.root.findByProps({ role: "listbox" }).props.hidden, true);
    let escapePrevented = false;
    act(() => combobox().props.onKeyDown({
      ...key("Escape"),
      preventDefault: () => { escapePrevented = true; },
    }));
    assert.equal(escapePrevented, false);
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

  assert.match(html, /role="group"[^>]*aria-label="Method states"/);
  assert.match(html, /role="group"[^>]*aria-labelledby="[^"]+"[^>]*>.*Clinical/s);
  assert.match(html, /role="group"[^>]*aria-labelledby="[^"]+"[^>]*>.*Instrument/s);
  assert.match(html, /role="option"[^>]*aria-selected="true"[^>]*>Not recorded/);
  assert.match(html, /min-h-11/);
  assert.match(html, /space-y-2/);
  assert.match(html, /gap-2/);
  assert.match(html, /--odos-text/);
  assert.match(html, /--odos-line/);
  assert.doesNotMatch(html, /(?:text|border|bg)-white/);
});

test("OdosSelect requires explicit parse and serialize hooks for editable generic values", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalDocument = globalThis.document;
  let changed: number | undefined;
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
          value={2}
          options={[
            { value: 1, label: "One" },
            { value: 2, label: "Two" },
          ]}
          onChange={(value) => { changed = value; }}
          onInputChange={(value) => { changed = value; }}
          parseInput={(input) => Number(input.replace("#", ""))}
          serializeValue={(value) => `#${value}`}
          ariaLabel="Numeric value"
        />,
      );
    });
    const input = renderer.root.findByProps({ role: "combobox" });
    assert.equal(input.props.value, "#2");
    act(() => input.props.onChange({ target: { value: "#3" } }));
    assert.equal(changed, 3);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
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
