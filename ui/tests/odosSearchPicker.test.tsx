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
    });
    await waitForObservable(
      () => Boolean(findButton(renderer!, "Create payer “New Payer”")),
      "create option for settled non-matching query",
    );
    const createButton = findButton(renderer!, "Create payer “New Payer”");
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

test("OdosSearchPicker suppresses exact-match creation and creates a non-match with Enter", async () => {
  const originalWindow = globalThis.window;
  const existing = {
    value: "payer-existing",
    label: "Existing Payer",
    description: "Plan directory result",
    item: { id: "payer-existing" },
  };
  let createdName = "";
  let selected: OdosSearchPickerOption<{ id: string }> | undefined;
  let prevented = false;
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
          search={async (query) => query.toLocaleLowerCase() === "existing payer" ? [existing] : []}
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
    const input = () => renderer!.root.find(
      (node) => node.type === "input" && node.props.placeholder === "Search payer",
    );

    await act(async () => {
      input().props.onChange({ target: { value: "existing payer" } });
    });
    await waitForObservable(
      () => hasOptionLabel(renderer!, "Existing Payer"),
      "existing payer result for settled exact-match query",
    );
    const existingOption = renderer!.root.findAllByProps({ role: "option" })[0]!;
    assert.equal(existingOption.props["aria-label"], undefined);
    assert.match(existingOption.findAllByType("span").map((span) => span.children.join("")).join(" "), /Plan directory result/);
    assert.equal(
      renderer!.root.findAllByType("button")
        .some((button) => button.children.join("").startsWith("Create payer")),
      false,
    );

    await act(async () => {
      input().props.onChange({ target: { value: "New Payer" } });
    });
    await waitForObservable(
      () => Boolean(findButton(renderer!, "Create payer “New Payer”")),
      "create option for settled non-matching query",
    );
    await act(async () => {
      input().props.onKeyDown({
        key: "Enter",
        preventDefault: () => { prevented = true; },
      });
      await Promise.resolve();
    });
    assert.equal(prevented, true);
    assert.equal(createdName, "New Payer");
    assert.equal(selected?.value, "payer-new");
  } finally {
    if (renderer) act(() => renderer!.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("OdosSearchPicker blocks Enter-to-create before debounce and while the current search is pending", async () => {
  const originalWindow = globalThis.window;
  let scheduledSearch: (() => void) | undefined;
  let resolveSearch!: (options: OdosSearchPickerOption<{ id: string }>[]) => void;
  const pendingSearch = new Promise<OdosSearchPickerOption<{ id: string }>[]>((resolve) => {
    resolveSearch = resolve;
  });
  let createCalls = 0;
  let renderer: ReactTestRenderer | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => {
        scheduledSearch = callback;
        return 1;
      },
      clearTimeout: () => {
        scheduledSearch = undefined;
      },
    },
  });
  try {
    await act(async () => {
      renderer = create(
        <OdosSearchPicker
          label="Payer"
          value=""
          placeholder="Search payer"
          search={() => pendingSearch}
          onSelect={() => undefined}
          onClear={() => undefined}
          onCreate={async (name) => {
            createCalls += 1;
            return { value: "payer-new", label: name, item: { id: "payer-new" } };
          }}
          createLabel="Create payer"
          searchDelayMs={250}
        />,
      );
    });
    const input = () => renderer!.root.find(
      (node) => node.type === "input" && node.props.placeholder === "Search payer",
    );
    const pressEnter = () => input().props.onKeyDown({
      key: "Enter",
      preventDefault: () => undefined,
    });

    act(() => input().props.onChange({ target: { value: "Pending Payer" } }));
    assert.equal(findButton(renderer!, "Create payer “Pending Payer”"), undefined);
    act(pressEnter);
    assert.equal(createCalls, 0);

    assert.ok(scheduledSearch);
    act(() => scheduledSearch?.());
    assert.equal(findButton(renderer!, "Create payer “Pending Payer”"), undefined);
    act(pressEnter);
    assert.equal(createCalls, 0);

    await act(async () => {
      resolveSearch([]);
      await pendingSearch;
    });
    await waitForObservable(
      () => Boolean(findButton(renderer!, "Create payer “Pending Payer”")),
      "create option after the pending search settles",
    );
    assert.equal(createCalls, 0);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("OdosSearchPicker keeps creation blocked when search fails", async () => {
  let createCalls = 0;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <OdosSearchPicker
        label="Payer"
        value=""
        placeholder="Search payer"
        search={async () => { throw new Error("Search unavailable"); }}
        onSelect={() => undefined}
        onClear={() => undefined}
        onCreate={async (name) => {
          createCalls += 1;
          return { value: "payer-new", label: name, item: { id: "payer-new" } };
        }}
        createLabel="Create payer"
        searchDelayMs={0}
      />,
    );
  });
  const input = renderer.root.find(
    (node) => node.type === "input" && node.props.placeholder === "Search payer",
  );
  await act(async () => {
    input.props.onChange({ target: { value: "Unknown Payer" } });
  });
  await waitForObservable(
    () => renderer!.root.findAllByProps({ role: "alert" }).length === 1,
    "failed-search alert",
  );
  assert.equal(findButton(renderer, "Create payer “Unknown Payer”"), undefined);
  act(() => input.props.onKeyDown({ key: "Enter", preventDefault: () => undefined }));
  assert.equal(createCalls, 0);
  act(() => renderer!.unmount());
});

function findButton(renderer: ReactTestRenderer, text: string) {
  return renderer.root.findAllByType("button")
    .find((button) => button.children.join("") === text);
}

function hasOptionLabel(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByProps({ role: "option" }).some(
    (option) => option.findAllByType("span").some((span) => span.children.join("") === label),
  );
}

async function waitForObservable(predicate: () => boolean, description: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
  assert.fail(`Timed out waiting for ${description}`);
}
