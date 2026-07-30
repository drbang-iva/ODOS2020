import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { normalizeWheelValue, OdosWheel } from "../src/components/inputs/OdosWheel";

test("OdosWheel centerOn stays a required compile-time prop", () => {
  const tsc = fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));
  execFileSync(tsc, [
    "--noEmit",
    "--skipLibCheck",
    "--jsx", "react-jsx",
    "--module", "ESNext",
    "--moduleResolution", "Bundler",
    "--target", "ES2022",
    fileURLToPath(new URL("./odosWheelCenterOn.typecheck.tsx", import.meta.url)),
  ], { stdio: "pipe" });
});

test("OdosWheel opens centered on centerOn rather than the first row", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalDocument = globalThis.document;
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
        <OdosWheel
          value={-1}
          centerOn={0}
          min={-1}
          max={1}
          step={0.25}
          format={String}
          onChange={() => undefined}
          ariaLabel="Sphere"
        />,
        {
          createNodeMock: (element) => {
            if (element.type === "input") {
              return {
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
              };
            }
            if (typeof element.props.className === "string" && element.props.className.includes("overflow-y-auto")) {
              return {
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
              };
            }
            return element.props["data-center"] === "true"
              ? { scrollIntoView: () => { centered = true; } }
              : {};
          },
        },
      );
    });
    act(() => renderer!.root.findByProps({ "aria-label": "Sphere wheel" }).props.onClick());
    assert.equal(centered, true);
    const center = renderer!.root.findAllByProps({ role: "option" })
      .find((option) => option.props["data-center"] === "true");
    assert.equal(center?.children.join(""), "0");
  } finally {
    if (renderer) act(() => renderer!.unmount());
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("OdosWheel uses native scroll snap without pointer physics", () => {
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <OdosWheel
        value={0}
        centerOn={0}
        min={-1}
        max={1}
        step={0.25}
        format={String}
        onChange={() => undefined}
        ariaLabel="Power"
      />,
    );
  });
  const list = renderer.root.find((node) =>
    typeof node.props.className === "string" && node.props.className.includes("overflow-y-auto"));
  assert.match(list.props.className, /snap-y/);
  assert.match(list.props.className, /snap-mandatory/);
  assert.match(list.props.className, /overscroll-contain/);
  assert.doesNotMatch(list.props.className, /touch-none/);
  assert.equal(list.props.onPointerDown, undefined);
  assert.equal(list.props.onPointerMove, undefined);
  assert.equal(list.props.onPointerUp, undefined);
  assert.equal(list.props.onPointerCancel, undefined);
  let prevented = false;
  list.props.onWheel({
    currentTarget: { clientHeight: 100, scrollHeight: 500, scrollTop: 400 },
    deltaY: 1,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  act(() => renderer.unmount());
});

test("OdosWheel commits the centered option on native scrollend", () => {
  let changed: number | undefined;
  let scrollEnd: (() => void) | undefined;
  let optionIndex = 0;
  const list = {
    clientHeight: 100,
    onscrollend: null,
    scrollTop: 232,
    getBoundingClientRect: () => ({ height: 100, top: 0 }),
    addEventListener: (type: string, listener: () => void) => {
      if (type === "scrollend") scrollEnd = listener;
    },
    removeEventListener: () => undefined,
  };
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <OdosWheel
        value={0}
        centerOn={0}
        min={-1}
        max={1}
        step={0.25}
        format={String}
        onChange={(value) => { changed = value; }}
        ariaLabel="Power"
      />,
      {
        createNodeMock: (element) => {
          if (element.type === "input") {
            return {
              addEventListener: () => undefined,
              removeEventListener: () => undefined,
            };
          }
          if (typeof element.props.className === "string" && element.props.className.includes("overflow-y-auto")) {
            return list;
          }
          if (element.props.role === "option") {
            const index = optionIndex++;
            return {
              getBoundingClientRect: () => ({ height: 44, top: index * 52 - list.scrollTop }),
            };
          }
          return {};
        },
      },
    );
  });
  assert.ok(scrollEnd);
  act(() => scrollEnd?.());
  assert.equal(changed, 0.25);
  act(() => renderer.unmount());
});

test("OdosWheel debounces scroll settle when scrollend is unavailable", async () => {
  let changed: number | undefined;
  let scroll: (() => void) | undefined;
  let optionIndex = 0;
  const list = {
    clientHeight: 100,
    scrollTop: 232,
    getBoundingClientRect: () => ({ height: 100, top: 0 }),
    addEventListener: (type: string, listener: () => void) => {
      if (type === "scroll") scroll = listener;
    },
    removeEventListener: () => undefined,
  };
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <OdosWheel
        value={0}
        centerOn={0}
        min={-1}
        max={1}
        step={0.25}
        format={String}
        onChange={(value) => { changed = value; }}
        ariaLabel="Power"
      />,
      {
        createNodeMock: (element) => {
          if (element.type === "input") {
            return {
              addEventListener: () => undefined,
              removeEventListener: () => undefined,
            };
          }
          if (typeof element.props.className === "string" && element.props.className.includes("overflow-y-auto")) {
            return list;
          }
          if (element.props.role === "option") {
            const index = optionIndex++;
            return {
              getBoundingClientRect: () => ({ height: 44, top: index * 52 - list.scrollTop }),
            };
          }
          return {};
        },
      },
    );
  });
  assert.ok(scroll);
  await act(async () => {
    scroll?.();
    await new Promise((resolve) => setTimeout(resolve, 175));
  });
  assert.equal(changed, 0.25);
  act(() => renderer.unmount());
});

test("OdosWheel clamps and snaps typed values on blur", () => {
  let changed: number | undefined;
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <OdosWheel
        value={0}
        centerOn={0}
        min={-10}
        max={10}
        step={0.25}
        format={String}
        onChange={(value) => { changed = value; }}
        ariaLabel="Power"
      />,
    );
  });
  const input = () => renderer.root.find((node) => node.type === "input" && node.props["aria-label"] === "Power");
  act(() => input().props.onChange({ target: { value: "12.13" } }));
  act(() => input().props.onBlur());
  assert.equal(changed, 10);
  assert.equal(renderer.root.findByProps({ "aria-label": "Power" }).props.value, "10");
  assert.equal(normalizeWheelValue(0.37, -10, 10, 0.25), 0.25);
  act(() => renderer.unmount());
});

test("OdosWheel preserves a blank state while keeping direct typing available", () => {
  let changedState: string | undefined;
  let changedValue: number | undefined;
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <OdosWheel
        value={0}
        centerOn={0}
        min={-1}
        max={1}
        step={0.25}
        format={(value) => value === 0 ? "pl" : value.toFixed(2)}
        onChange={(value) => { changedValue = value; }}
        ariaLabel="Sphere"
        states={[{ value: "", label: "Not recorded" }]}
        selectedState=""
        onStateChange={(value) => { changedState = value; }}
      />,
    );
  });
  const input = () => renderer.root.findByProps({ "aria-label": "Sphere" });
  assert.equal(input().props.value, "");
  assert.equal(input().props.placeholder, "Not recorded");

  act(() => input().props.onChange({ target: { value: "-0.38" } }));
  act(() => input().props.onBlur());
  assert.equal(changedValue, -0.5);

  act(() => input().props.onChange({ target: { value: "" } }));
  act(() => input().props.onBlur());
  assert.equal(changedState, "");

  act(() => input().props.onChange({ target: { value: "0.5" } }));
  act(() => input().props.onKeyDown({
    key: "Escape",
    preventDefault: () => undefined,
  }));
  assert.equal(input().props.value, "");
  act(() => renderer.unmount());
});

test("OdosWheel reverts a cleared value when no blank state is configured", () => {
  const changes: number[] = [];
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <OdosWheel
        value={2}
        centerOn={0}
        min={1}
        max={10}
        step={1}
        format={String}
        onChange={(value) => { changes.push(value); }}
        ariaLabel="Drops 1"
      />,
    );
  });
  const input = () => renderer.root.findByProps({ "aria-label": "Drops 1" });
  act(() => input().props.onChange({ target: { value: "" } }));
  act(() => input().props.onBlur());
  assert.deepEqual(changes, []);
  assert.equal(input().props.value, "2");
  act(() => renderer.unmount());
});

test("OdosWheel formats idle values, closes on Enter, and skips unchanged change events", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalDocument = globalThis.document;
  const changes: number[] = [];
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
        <OdosWheel
          value={10}
          centerOn={0}
          min={-10}
          max={10}
          step={0.25}
          format={(value) => value.toFixed(2)}
          onChange={(value) => { changes.push(value); }}
          ariaLabel="Power"
        />,
      );
    });
    const input = () => renderer!.root.findByProps({ "aria-label": "Power" });
    assert.equal(input().props.value, "10.00");
    act(() => input().props.onKeyDown({
      key: "ArrowDown",
      preventDefault: () => undefined,
    }));
    assert.deepEqual(changes, []);

    act(() => input().props.onClick());
    assert.equal(renderer.root.findByProps({ role: "listbox" }).props.hidden, false);
    act(() => input().props.onChange({ target: { value: "9.87" } }));
    act(() => input().props.onKeyDown({
      key: "Enter",
      preventDefault: () => undefined,
    }));
    assert.deepEqual(changes, [9.75]);
    assert.equal(input().props.value, "9.75");
    assert.equal(renderer.root.findByProps({ role: "listbox" }).props.hidden, true);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("OdosWheel ignores native wheel input while disabled", () => {
  let wheelHandler: ((event: { deltaY: number; preventDefault: () => void }) => void) | undefined;
  let changed: number | undefined;
  let prevented = false;
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <OdosWheel
        value={0}
        centerOn={0}
        min={-1}
        max={1}
        step={0.25}
        format={String}
        onChange={(value) => { changed = value; }}
        ariaLabel="Power"
        disabled
      />,
      {
        createNodeMock: (element) => {
          if (element.type === "input") {
            return {
              addEventListener: (
                type: string,
                handler: (event: { deltaY: number; preventDefault: () => void }) => void,
              ) => {
                if (type === "wheel") wheelHandler = handler;
              },
              removeEventListener: () => undefined,
            };
          }
          if (typeof element.props.className === "string" && element.props.className.includes("overflow-y-auto")) {
            return {
              addEventListener: () => undefined,
              removeEventListener: () => undefined,
            };
          }
          return {};
        },
      },
    );
  });
  assert.ok(wheelHandler);
  act(() => wheelHandler?.({
    deltaY: 1,
    preventDefault: () => { prevented = true; },
  }));
  assert.equal(changed, undefined);
  assert.equal(prevented, false);
  act(() => renderer.unmount());
});
