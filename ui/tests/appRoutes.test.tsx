import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { RouteSwitch } from "../src/App";
import { OdosChips } from "../src/components/inputs/OdosChips";
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
  const admin = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/settings/optical-pricing" roles={["practice-admin"]} />,
  );
  const desk = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/settings/optical-pricing" roles={["front-desk"]} />,
  );
  assert.match(admin, /Optical pricing/);
  assert.match(admin, /Frame pricing/);
  assert.match(admin, /Contact lens pricing/);
  assert.doesNotMatch(admin, />Lens pricing</);
  assert.doesNotMatch(admin, /Read only. Practice-admin access is required/);
  assert.match(desk, /Read only. Practice-admin access is required/);
});

test("the Fee Schedule route is practice-admin writable and names the unpriced clinical fee catalog", () => {
  const admin = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/settings/fee-schedule" roles={["practice-admin"]} />,
  );
  const desk = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/settings/fee-schedule" roles={["front-desk"]} />,
  );
  assert.match(admin, /Fee Schedule/);
  assert.doesNotMatch(admin, /Read only. Practice-admin access is required/);
  assert.match(desk, /Read only. Practice-admin access is required/);
});

test("the four round-two settings routes render write controls only for authorized App roles", async () => {
  const cases: Array<{
    path: string;
    writeRoles: Array<"practice-admin" | "front-desk" | "clinician">;
    readRoles: Array<"practice-admin" | "front-desk" | "clinician">;
    writeControl: RegExp;
  }> = [
    { path: "/settings/optical-pricing", writeRoles: ["practice-admin"], readRoles: ["front-desk"], writeControl: /New contact lens price/ },
    { path: "/settings/floor-config", writeRoles: ["front-desk"], readRoles: ["clinician"], writeControl: /\+ Add .*station/ },
    { path: "/settings/visit-types", writeRoles: ["practice-admin"], readRoles: ["front-desk"], writeControl: /Use starter categories/ },
    { path: "/settings/vision-plan-templates", writeRoles: ["front-desk"], readRoles: ["clinician"], writeControl: /\+ Add .*plan template/ },
  ];
  for (const route of cases) {
    const writable = await renderAsyncRoute(route.path, route.writeRoles);
    const readOnly = await renderAsyncRoute(route.path, route.readRoles);
    assert.match(writable, route.writeControl, `${route.path} authorized UI`);
    assert.doesNotMatch(readOnly, route.writeControl, `${route.path} read-only UI`);
  }
});

test("audit log renders an empty patient filter", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "?role=auditor" } },
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ rows: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<RouteSwitch view={{ kind: "picker" }} path="/audit/log" />);
      await Promise.resolve();
    });
    const patientLabel = renderer.root.findAllByType("label").find((label) => label.children.includes("Patient"));
    assert.ok(patientLabel);
    assert.equal(patientLabel.findByType("input").props.value, "");
    const eventTypes = renderer.root.findByType(OdosChips);
    assert.equal(eventTypes.props.ariaLabel, "Audit event types");
    assert.deepEqual(eventTypes.props.selected, []);
    const firstEventType = eventTypes.props.options[0];
    assert.ok(firstEventType);
    act(() => renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === firstEventType.label)!
      .props.onClick());
    assert.deepEqual(renderer.root.findByType(OdosChips).props.selected, [firstEventType.value]);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
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

test("the treatment-protocol route reaches the practice-owned protocol editor", () => {
  const admin = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/settings/treatment-protocols" roles={["practice-admin"]} />,
  );
  const desk = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/settings/treatment-protocols" roles={["front-desk"]} />,
  );
  assert.match(admin, /Treatment protocols/);
  assert.doesNotMatch(admin, /Read only/);
  assert.match(desk, /Treatment protocols/);
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

test("the billing identity route reaches the practice-admin singleton form", () => {
  const html = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path="/settings/billing-identity" roles={["practice-admin"]} />,
  );
  assert.match(html, /Loading billing identity/);
});

test("the Appearance route reaches the practice-level scheme picker", () => {
  const html = renderToStaticMarkup(
    <RouteSwitch
      view={{ kind: "picker" }}
      path="/settings/appearance"
      roles={["practice-admin"]}
    />,
  );
  assert.match(html, /Appearance/);
  assert.match(html, /Loading appearance/);
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

async function renderAsyncRoute(path: string, roles: Array<"practice-admin" | "front-desk" | "clinician">): Promise<string> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/audit")) {
      return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ resourceType: "Bundle", type: "searchset", entry: [] }), {
      status: 200,
      headers: { "Content-Type": "application/fhir+json" },
    });
  };
  let renderer!: ReturnType<typeof create>;
  try {
    await act(async () => {
      renderer = create(<RouteSwitch view={{ kind: "picker" }} path={path} roles={roles} />);
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    return JSON.stringify(renderer.toJSON());
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
}
