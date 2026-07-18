import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ConfirmDelete, ListHeader, RequiredGate } from "../src/components/settings";

test("ListHeader renders search, filter slots, and the primary New action", () => {
  const html = renderToStaticMarkup(
    <ListHeader
      title="Frames"
      searchValue=""
      filters={<select aria-label="Status filter"><option>Active</option></select>}
      newActionLabel="New frame"
      onSearchChange={() => undefined}
      onNew={() => undefined}
    />,
  );

  assert.match(html, /Search Frames/);
  assert.match(html, /Status filter/);
  assert.match(html, />New frame</);
});

test("ConfirmDelete requires confirmation before invoking the destructive callback", async () => {
  let calls = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ConfirmDelete
        title="Delete frame?"
        consequence="14 historical orders keep their record; the frame leaves the catalog."
        onConfirm={() => { calls += 1; }}
      />,
    );
  });

  await act(async () => {
    renderer.root.findByType("button").props.onClick();
  });
  assert.equal(calls, 0);
  assert.equal(renderer.root.findByProps({ role: "alertdialog" }).props["aria-modal"], "true");
  assert.match(
    renderer.root.findByProps({ role: "alertdialog" }).findByType("p").children.join(""),
    /14 historical orders/,
  );

  const confirm = renderer.root
    .findByProps({ role: "alertdialog" })
    .findAllByType("button")
    .find((button) => button.children.join("") === "Delete");
  assert.ok(confirm);
  await act(async () => {
    await confirm.props.onClick();
  });
  assert.equal(calls, 1);
  assert.equal(renderer.root.findAllByProps({ role: "alertdialog" }).length, 0);
  act(() => renderer.unmount());
});

test("RequiredGate disables Save until required values exist and jumps to the first missing field", async () => {
  let saves = 0;
  let focused = "";
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById(id: string) {
        return { focus: () => { focused = id; } };
      },
    },
  });

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <RequiredGate
        fields={[{ key: "name", label: "Name" }, { key: "code", label: "Code" }]}
        values={{ name: "", code: "A1" }}
        fieldId={(key) => `field-${key}`}
        onSave={() => { saves += 1; }}
      />,
    );
  });

  const disabledSave = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save");
  assert.equal(disabledSave?.props.disabled, true);
  const jump = renderer.root.findAllByType("button").find((button) => button.children.join("").includes("jump to it"));
  assert.ok(jump);
  act(() => jump.props.onClick());
  assert.equal(focused, "field-name");

  await act(async () => {
    renderer.update(
      <RequiredGate
        fields={[{ key: "name", label: "Name" }, { key: "code", label: "Code" }]}
        values={{ name: "Avery", code: "A1" }}
        fieldId={(key) => `field-${key}`}
        onSave={() => { saves += 1; }}
      />,
    );
  });
  const enabledSave = renderer.root.findByType("button");
  assert.equal(enabledSave.props.disabled, false);
  act(() => enabledSave.props.onClick());
  assert.equal(saves, 1);
  act(() => renderer.unmount());

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: previousDocument,
  });
});
