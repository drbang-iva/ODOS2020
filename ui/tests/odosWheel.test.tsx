import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { normalizeWheelValue, OdosWheel } from "../src/components/inputs/OdosWheel";

test("OdosWheel centerOn stays a required compile-time prop", () => {
  const tsc = new URL("../node_modules/.bin/tsc", import.meta.url);
  execFileSync(tsc.pathname, [
    "--noEmit",
    "--skipLibCheck",
    "--jsx", "react-jsx",
    "--module", "ESNext",
    "--moduleResolution", "Bundler",
    "--target", "ES2022",
    new URL("./odosWheelCenterOn.typecheck.tsx", import.meta.url).pathname,
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
          createNodeMock: (element) => element.props["data-center"] === "true"
            ? { scrollIntoView: () => { centered = true; } }
            : {},
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
