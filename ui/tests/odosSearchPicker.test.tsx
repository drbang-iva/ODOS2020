import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { OdosSearchPicker, type OdosSearchPickerOption } from "../src/components/inputs/OdosSearchPicker";

test("OdosSearchPicker creates and selects a non-matching query as a structured option", async () => {
  const originalWindow = globalThis.window;
  let createdName = "";
  let selected: OdosSearchPickerOption<{ id: string }> | undefined;
  let renderer: ReactTestRenderer | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => globalThis.setTimeout(callback, 0),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  try {
    await act(async () => {
      renderer = create(
        <OdosSearchPicker
          label="Payer"
          value=""
          placeholder="Search payer"
          search={async () => []}
          onSelect={(option) => { selected = option; }}
          onClear={() => undefined}
          onCreate={async (name) => {
            createdName = name;
            return { value: "payer-new", label: name, item: { id: "payer-new" } };
          }}
          createLabel="Create payer"
          searchDelayMs={0}
        />,
      );
    });
    await act(async () => {
      renderer!.root.find((node) => node.type === "input" && node.props.placeholder === "Search payer")
        .props.onChange({ target: { value: "New Payer" } });
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    });
    const createButton = renderer!.root.findAllByType("button")
      .find((button) => button.children.join("") === "Create payer “New Payer”");
    assert.ok(createButton);
    assert.match(createButton.props.className, /min-h-11/);
    await act(async () => {
      createButton.props.onClick();
      await Promise.resolve();
    });
    assert.equal(createdName, "New Payer");
    assert.deepEqual(selected, {
      value: "payer-new",
      label: "New Payer",
      item: { id: "payer-new" },
    });
  } finally {
    if (renderer) act(() => renderer!.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
