import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { MethodField } from "../src/components/inputs/MethodField";
import { OdosSelect } from "../src/components/inputs/OdosSelect";

test("MethodField keeps measurement value and method in separate bound controls", () => {
  let seen = { value: "", method: "" };
  function Harness() {
    const [value, setValue] = React.useState("43.25");
    const [method, setMethod] = React.useState("manual");
    seen = { value, method };
    return (
      <MethodField
        label="Keratometry"
        renderValueControl={({ disabled }) => (
          <input
            aria-label="Keratometry value"
            value={value}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        methodValue={method}
        methodOptions={[
          { value: "manual", label: "Manual" },
          { value: "auto", label: "Auto" },
        ]}
        onMethodChange={setMethod}
        methodAriaLabel="Keratometry method"
      />
    );
  }

  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Harness />);
  });
  act(() => renderer.root.findByType(OdosSelect).props.onChange("auto"));
  assert.deepEqual(seen, { value: "43.25", method: "auto" });
  assert.equal(renderer.root.findByProps({ "aria-label": "Keratometry value" }).props.value, "43.25");
  act(() => renderer.root.findByProps({ "aria-label": "Keratometry value" }).props.onChange({
    target: { value: "44.00" },
  }));
  assert.deepEqual(seen, { value: "44.00", method: "auto" });
  act(() => renderer.unmount());
});

test("MethodField disables its fieldset, value control, and method control as one unit", () => {
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <MethodField
        disabled
        renderValueControl={({ disabled }) => (
          <input aria-label="Keratometry value" disabled={disabled} />
        )}
        methodValue="manual"
        methodOptions={[{ value: "manual", label: "Manual" }]}
        onMethodChange={() => undefined}
        methodAriaLabel="Keratometry method"
      />,
    );
  });
  assert.equal(renderer.root.findByType("fieldset").props.disabled, true);
  assert.equal(renderer.root.findByProps({ "aria-label": "Keratometry value" }).props.disabled, true);
  assert.equal(renderer.root.findByType(OdosSelect).props.disabled, true);
  act(() => renderer.unmount());
});
