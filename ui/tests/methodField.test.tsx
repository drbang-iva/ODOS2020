import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { MethodField } from "../src/components/inputs/MethodField";
import { OdosSelect } from "../src/components/inputs/OdosSelect";

test("MethodField keeps measurement value and method in separate bound controls", () => {
  let value = "43.25";
  let method = "manual";
  const renderer = create(
    <MethodField
      label="Keratometry"
      valueControl={(
        <input
          aria-label="Keratometry value"
          value={value}
          onChange={(event) => { value = event.target.value; }}
        />
      )}
      methodValue={method}
      methodOptions={[
        { value: "manual", label: "Manual" },
        { value: "auto", label: "Auto" },
      ]}
      onMethodChange={(next) => { method = next; }}
      methodAriaLabel="Keratometry method"
    />,
  );

  act(() => renderer.root.findByType(OdosSelect).props.onChange("auto"));
  assert.equal(method, "auto");
  assert.equal(value, "43.25");
  assert.equal(renderer.root.findByProps({ "aria-label": "Keratometry value" }).props.value, "43.25");
  act(() => renderer.unmount());
});
