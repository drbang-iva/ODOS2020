import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { OdosChips } from "../src/components/inputs/OdosChips";

test("OdosChips toggling the same option twice returns to the original selected set", () => {
  const changes: string[][] = [];
  function Harness() {
    const [selected, setSelected] = React.useState<string[]>([]);
    return (
      <OdosChips
        options={[
          { value: "tropicamide", label: "Tropicamide" },
          { value: "cyclomydril", label: "Cyclomydril" },
        ]}
        selected={selected}
        onChange={(next) => {
          changes.push(next);
          setSelected(next);
        }}
        ariaLabel="Dilation agents"
      />
    );
  }

  const renderer = create(<Harness />);
  const chip = () => renderer.root.findAllByType("button")
    .find((button) => button.children.join("") === "Tropicamide")!;
  act(() => chip().props.onClick());
  assert.equal(chip().props["aria-pressed"], true);
  act(() => chip().props.onClick());
  assert.equal(chip().props["aria-pressed"], false);
  assert.deepEqual(changes, [["tropicamide"], []]);
  assert.match(chip().props.className, /min-h-11/);
  act(() => renderer.unmount());
});
