import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PowerDropdown } from "../src/components/charting/PowerDropdown";

test("PowerDropdown keeps the current free-typed value in a text input", () => {
  const html = renderToStaticMarkup(
    <PowerDropdown
      value="-18.37"
      options={["0.00", "-0.25"]}
      defaultValue="0.00"
      onChange={() => undefined}
      ariaLabel="OD sphere"
    />,
  );

  assert.match(html, /type="text"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /value="-18.37"/);
});

test("PowerDropdown renders caller-formatted options and marks the open-at default", () => {
  const html = renderToStaticMarkup(
    <PowerDropdown
      value="-0.25"
      options={["0.00", "-0.25", "-0.50"]}
      defaultValue="0.00"
      onChange={() => undefined}
      ariaLabel="OD cylinder"
      formatOption={(option) => option === "0.00" ? "Plano" : option}
    />,
  );

  assert.match(html, /role="listbox"/);
  assert.match(html, /Plano/);
  assert.match(html, /-0\.25/);
  assert.match(html, /data-default="true"/);
  assert.match(html, /aria-selected="true"/);
});
