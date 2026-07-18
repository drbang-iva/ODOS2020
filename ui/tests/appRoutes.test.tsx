import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("the Statements route reaches the printable balance-forward scene", () => {
  const html = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/billing/statements" />,
  );
  assert.match(html, /Statements/);
  assert.match(html, /Run statements/);
  assert.match(html, /No mail or email transport is connected/);
});

test("the settings index route reaches the shared settings stub", () => {
  const html = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path="/settings" />);
  assert.match(html, /Practice Admin/);
  assert.match(html, /Settings sections/);
  assert.match(html, /Chart fields and sections/);
  assert.match(html, /Frames data/);
  assert.match(html, /Floor config/);
  assert.match(html, /Vision plan templates/);
  assert.match(html, /Visit types/);
  assert.match(html, /Suggested diagnoses/);
  assert.match(html, /Optical pricing/);
  assert.doesNotMatch(html, /Plan profiles/);
});

test("the optical-pricing route keeps frame and contact-lens pricing separate from the Lens Catalog", () => {
  const html = renderToStaticMarkup(
    <RoleProvider>
      <RouteSwitch view={{ kind: "picker" }} path="/settings/optical-pricing" />
    </RoleProvider>,
  );
  assert.match(html, /Optical pricing/);
  assert.match(html, /Frame pricing/);
  assert.match(html, /Contact lens pricing/);
  assert.doesNotMatch(html, />Lens pricing</);
  assert.match(html, /Read only. Practice-admin access is required/);
});

test("the Lens Catalog route reaches its dedicated manager with practice-admin write gating", () => {
  const admin = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/settings/lens-catalog" roles={["practice-admin"]} />,
  );
  const desk = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/settings/lens-catalog" roles={["front-desk"]} />,
  );
  assert.match(admin, /Lens Catalog/);
  assert.match(admin, /Lens products/);
  assert.doesNotMatch(admin, /Read only/);
  assert.match(desk, /Read only. Practice-admin access is required/);
});

test("the plan-profile route reaches the owner settings scene with actual-role write gating", () => {
  const admin = renderToStaticMarkup(
    <RouteSwitch
      view={{ kind: "picker" }}
      path="/settings/plan-profiles"
      roles={["practice-admin"]}
    />,
  );
  const desk = renderToStaticMarkup(
    <RouteSwitch
      view={{ kind: "picker" }}
      path="/settings/plan-profiles"
      roles={["front-desk"]}
    />,
  );
  assert.match(admin, /Plan profiles/);
  assert.doesNotMatch(admin, /Read only/);
  assert.match(desk, /Read only. Practice-admin access is required/);
});

test("the statement-message route reaches the practice-admin editor", () => {
  const html = renderToStaticMarkup(
    <RouteSwitch
      view={{ kind: "picker" }}
      path="/settings/statement-messages"
      roles={["practice-admin"]}
    />,
  );
  assert.match(html, /Statement and receipt messages/);
  assert.match(html, /Loading statement and receipt messages/);
});

test("the Financials Practice margin route reaches the read-only ledger surface", () => {
  const html = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/financials/practice/margins" search="?period=2026-07" roles={["practice-admin"]} />,
  );
  assert.match(html, /Product <span>Margin Ledger<\/span>/);
  assert.match(html, /The ledger begins <strong>2026-07-15<\/strong>/);
  assert.doesNotMatch(html, /Save|Reprice|Write back/);
});

test("the suggested-diagnoses route reaches the shared catalog editor scene", () => {
  const html = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/settings/suggested-diagnoses" />,
  );
  assert.match(html, /Loading diagnosis settings/);
});

test("the visit-type route reaches the mixed singleton and resource settings scene", () => {
  const html = renderToStaticMarkup(
    <RoleProvider>
      <RouteSwitch view={{ kind: "picker" }} path="/settings/visit-types" />
    </RoleProvider>,
  );
  assert.match(html, /Practice Settings/);
  assert.match(html, /Visit types/);
  assert.match(html, /Loading visit types/);
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

test("the new-patient route reaches the front-desk registration scene", () => {
  const html = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path="/patient/new" />);
  assert.match(html, /Front desk/);
  assert.match(html, /New patient/);
  assert.match(html, /Create patient/);
});

test("the Desk home and existing front-desk cockpit remain separate routes", () => {
  const desk = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path="/desk" />);
  const cockpit = renderToStaticMarkup(
    <RoleProvider><RouteSwitch view={{ kind: "picker" }} path="/frontdesk" /></RoleProvider>,
  );
  assert.match(desk, /The Desk/);
  assert.match(desk, /Customize/);
  assert.match(cockpit, /Front desk/);
  assert.match(cockpit, /schedule/);
  assert.doesNotMatch(cockpit, /The Desk/);
});

test("the Clinic route opens the real Clinic home while the patient picker stays reachable", () => {
  const clinic = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path="/clinic" />);
  const picker = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path="/clinic/patients" />);
  assert.match(clinic, /The Clinic/);
  assert.match(clinic, /Today&#x27;s flow/);
  assert.match(picker, /Patient Picker/);
  assert.doesNotMatch(clinic, /The Desk/);
});

test("insurance screens expose the MCP base URL as a literal Vite environment reference", () => {
  for (const scene of ["PatientInsurance.tsx", "VisionPlanBenefits.tsx"]) {
    const source = readFileSync(new URL(`../src/scenes/insurance/${scene}`, import.meta.url), "utf8");
    assert.match(source, /import\.meta\.env\.VITE_ODOS_MCP_BASE_URL/);
    assert.doesNotMatch(source, /const meta = import\.meta as/);
  }
});
