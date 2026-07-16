import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsIndex } from "../src/scenes/settings/SettingsIndex";

const ALL_SETTINGS_HREFS = [
  "/settings/staff",
  "/settings/visit-types",
  "/settings/floor-config",
  "/settings/vision-plan-templates",
  "/settings/chart-fields-sections",
  "/settings/suggested-diagnoses",
  "/settings/optical-pricing",
  "/admin/practice/settings/frames-data",
] as const;

test("Practice landing groups all eight existing settings without changing their routes", () => {
  const html = renderToStaticMarkup(<SettingsIndex roles={["practice-admin"]} />);

  for (const href of ALL_SETTINGS_HREFS) {
    assert.match(html, new RegExp(`href="${href.replaceAll("/", "\\/")}"`));
  }
  for (const group of ["People &amp; Access", "Clinical", "Schedule", "Financial", "Inventory", "Communications", "Practice"]) {
    assert.match(html, new RegExp(`>${group}<`));
  }
  assert.match(html, /practice-settings-tone-gold/);
  assert.equal((html.match(/class="practice-settings-manage"/g) ?? []).length, 8);
});

test("Find a setting filters static Manage links and Cmd-K focuses the search", async () => {
  let keydown: ((event: KeyboardEvent) => void) | undefined;
  let focused = false;
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener(type: string, listener: EventListener) {
        if (type === "keydown") keydown = listener as (event: KeyboardEvent) => void;
      },
      removeEventListener() {},
    },
  });

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<SettingsIndex roles={["practice-admin"]} />, {
      createNodeMock(element) {
        if (element.type === "input" && element.props.placeholder === "Find a setting") {
          return { focus: () => { focused = true; } };
        }
        return {};
      },
    });
  });

  const search = renderer.root.findByProps({ placeholder: "Find a setting" });
  await act(async () => {
    search.props.onChange({ target: { value: "insurance benefits" } });
  });
  const links = renderer.root.findAllByType("a");
  assert.deepEqual(links.map((link) => link.props.href), ["/settings/vision-plan-templates"]);

  let prevented = false;
  assert.ok(keydown);
  act(() => keydown?.({
    key: "k",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    target: null,
    preventDefault: () => { prevented = true; },
  } as unknown as KeyboardEvent));
  assert.equal(prevented, true);
  assert.equal(focused, true);
  act(() => renderer.unmount());

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: previousDocument,
  });
});
