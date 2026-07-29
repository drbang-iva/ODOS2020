import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { EyePairRow } from "../src/components/inputs/EyePairRow";

test("EyePairRow copies through child onChange callbacks and publishes an editable Recorded On value", () => {
  let od = "OD value";
  let os = "OS value";
  const recorded: string[] = [];
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <EyePairRow
        label="Finding"
        odValue={od}
        osValue={os}
        onOdChange={(value) => { od = value; }}
        onOsChange={(value) => { os = value; }}
        renderControl={({ eye, value, onChange, disabled }) => (
          <input
            aria-label={`${eye} finding`}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        recordedOn=""
        onRecordedOnChange={(value) => { recorded.push(value); }}
      />,
    );
  });
  assert.match(recorded[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(recorded.length, 1);
  act(() => renderer.root.findByProps({ "aria-label": "OD finding" }).props.onChange({
    target: { value: "OD edited" },
  }));
  assert.equal(od, "OD edited");
  act(() => renderer.root.findByProps({ "aria-label": "OS finding" }).props.onChange({
    target: { value: "OS edited" },
  }));
  assert.equal(os, "OS edited");
  act(() => renderer.root.findByProps({ "aria-label": "Copy OD to OS" }).props.onClick());
  assert.equal(os, "OD value");
  act(() => renderer.root.findByProps({ "aria-label": "Copy OS to OD" }).props.onClick());
  assert.equal(od, "OS value");

  const timestamp = renderer.root.findByProps({ type: "datetime-local" });
  assert.equal(timestamp.props.value, recorded[0]);
  act(() => timestamp.props.onChange({ target: { value: "2026-07-29T09:30" } }));
  assert.equal(recorded.at(-1), "2026-07-29T09:30");
  assert.match(renderer.root.findByProps({ "aria-label": "Copy OD to OS" }).props.className, /min-h-11/);
  act(() => renderer.unmount());
});

test("EyePairRow keeps every child disabled and defers its initial timestamp until enabled", () => {
  const recorded: string[] = [];
  const onRecordedOnChange = (value: string) => { recorded.push(value); };
  const renderRow = (disabled: boolean) => (
    <EyePairRow
      odValue="OD value"
      osValue="OS value"
      onOdChange={() => undefined}
      onOsChange={() => undefined}
      renderControl={({ eye, disabled: childDisabled }) => (
        <input aria-label={`${eye} finding`} disabled={childDisabled} />
      )}
      recordedOn=""
      onRecordedOnChange={onRecordedOnChange}
      disabled={disabled}
    />
  );

  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(renderRow(true));
  });
  assert.equal(recorded.length, 0);
  assert.equal(renderer.root.findByType("fieldset").props.disabled, true);
  assert.equal(renderer.root.findByProps({ "aria-label": "OD finding" }).props.disabled, true);
  assert.equal(renderer.root.findByProps({ "aria-label": "OS finding" }).props.disabled, true);

  act(() => renderer.update(renderRow(false)));
  assert.equal(recorded.length, 1);
  assert.match(recorded[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  act(() => renderer.update(renderRow(false)));
  assert.equal(recorded.length, 1);
  act(() => renderer.unmount());
});
