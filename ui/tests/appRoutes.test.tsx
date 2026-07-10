import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouteSwitch } from "../src/App";
import { RoleProvider } from "../src/lib/role-context";

test("the Accounts Receivable dashboard UI route reaches the dashboard without replacing existing routing", () => {
  const html = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/billing/claims/reports/accounts-receivable" />,
  );
  assert.match(html, /Accounts receivable/);
  assert.match(html, /Loading accounts receivable/);
});

test("the settings index route reaches the shared settings stub", () => {
  const html = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path="/settings" />);
  assert.match(html, /Practice Admin/);
  assert.match(html, /Settings sections/);
  assert.match(html, /Chart fields and sections/);
  assert.match(html, /Frames data/);
  assert.match(html, /Floor config/);
  assert.match(html, /Vision plan templates/);
  assert.doesNotMatch(html, /Visit types/);
});

test("the floor-config settings route reaches the real singleton settings scene", () => {
  const html = renderToStaticMarkup(
    <RoleProvider>
      <RouteSwitch view={{ kind: "picker" }} path="/settings/floor-config" />
    </RoleProvider>,
  );
  assert.match(html, /Practice Settings/);
  assert.match(html, /Floor config/);
  assert.match(html, /Loading floor config/);
});

test("the vision plan-template route reaches the insurance singleton settings scene", () => {
  const html = renderToStaticMarkup(
    <RoleProvider>
      <RouteSwitch view={{ kind: "picker" }} path="/settings/vision-plan-templates" />
    </RoleProvider>,
  );
  assert.match(html, /Practice Settings/);
  assert.match(html, /Vision plan templates/);
  assert.match(html, /Loading vision plan templates/);
});
