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
        renderControl={({ eye, value, onChange }) => (
          <input
            aria-label={`${eye} finding`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        recordedOn=""
        onRecordedOnChange={(value) => { recorded.push(value); }}
      />,
    );
  });
  assert.match(recorded[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
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
