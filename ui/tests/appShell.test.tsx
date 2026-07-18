import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { App, RoleSwitchPill, RouteSwitch } from "../src/App";
import { AppShell, sessionEmailFromProfile } from "../src/components/AppShell";
import { fhir, SESSION_STORAGE_KEY } from "../src/lib/fhir";
import { ClinicHome } from "../src/scenes/ClinicHome";
import { DeskHome } from "../src/scenes/DeskHome";

test("AppShell renders every global control and a linked breadcrumb on a deep route", () => {
  const html = renderToStaticMarkup(
    <AppShell
      path="/settings/staff"
      roles={["practice-admin", "clinician"]}
      homePath="/desk"
      side="desk"
      email="eric.bang@example.test"
      switchPill={<RoleSwitchPill target="/clinic" />}
    >
      <RouteSwitch view={{ kind: "picker" }} path="/settings/staff" roles={["practice-admin", "clinician"]} />
    </AppShell>,
  );

  assert.equal((html.match(/data-testid="app-shell"/g) ?? []).length, 1);
  assert.match(html, /href="\/desk"[^>]*>ODOS/);
  assert.match(html, /aria-label="Breadcrumb"[\s\S]*href="\/settings"[\s\S]*Staff/);
  assert.match(html, /placeholder="Find a patient — name, DOB, chart #"/);
  assert.match(html, /href="\/schedule\/day"[^>]*>[\s\S]*Schedule/);
  assert.match(html, />Sections<\/button>/);
  assert.match(html, /New…/);
  assert.match(html, /aria-label="Office"/);
  assert.match(html, /Switch to Clinic/);
  assert.match(html, /aria-label="Account menu"/);
  assert.match(html, /eric\.bang@example\.test/);
  assert.match(html, /Practice admin · Clinician/);
  assert.match(html, />Logout<\/button>/);
  assert.match(html, /Invite a staff member/);
});

test("AppShell registers the statement-message settings breadcrumb", () => {
  const html = renderToStaticMarkup(
    <AppShell
      path="/settings/statement-messages"
      roles={["practice-admin"]}
      homePath="/desk"
      side="desk"
      email="admin@example.test"
    >
      <main />
    </AppShell>,
  );
  assert.match(
    html,
    /aria-label="Breadcrumb"[\s\S]*href="\/settings"[\s\S]*Statement and receipt messages/,
  );
});

test("unified Sections includes Schedule and applies the existing practice-admin Settings gate", () => {
  const frontDesk = renderToStaticMarkup(<AppShell path="/desk" roles={["front-desk"]} homePath="/desk" side="desk" email="desk@example.test"><main /></AppShell>);
  const admin = renderToStaticMarkup(<AppShell path="/desk" roles={["practice-admin"]} homePath="/desk" side="desk" email="admin@example.test"><main /></AppShell>);
  assert.match(frontDesk, /href="\/schedule\/day"[\s\S]*Schedule/);
  assert.doesNotMatch(frontDesk, /href="\/settings"/);
  assert.match(admin, /href="\/settings"[\s\S]*Administration \/ Settings/);
});

test("AppShell leaves account-menu overflow visible and places Sections in the right control cluster", () => {
  const html = renderToStaticMarkup(
    <AppShell
      path="/settings/staff"
      roles={["practice-admin", "clinician"]}
      homePath="/desk"
      side="desk"
      email="eric.bang@example.test"
      switchPill={<RoleSwitchPill target="/clinic" />}
    >
      <main />
    </AppShell>,
  );
  const header = html.match(/<header class="odos-desk-topbar[\s\S]*?<\/header>/)?.[0] ?? "";
  const css = readFileSync(new URL("../src/styles/desk-home.css", import.meta.url), "utf8");
  const topbar = css.match(/\.odos-desk-topbar \{[^}]*\}/)?.[0] ?? "";

  assert.match(header, /class="odos-desk-topbar flex-wrap"/);
  assert.doesNotMatch(header, /overflow-x-auto|flex-nowrap/);
  assert.match(topbar, /flex-wrap: wrap/);
  assert.match(topbar, /overflow: visible/);
  assert.match(topbar, /z-index: 30/);

  const newIndex = header.indexOf("New…");
  const sectionsIndex = header.indexOf(">Sections</button>");
  const officeIndex = header.indexOf('aria-label="Office"');
  const switchIndex = header.indexOf("Switch to Clinic");
  const accountIndex = header.indexOf('aria-label="Account menu"');
  assert.ok(newIndex >= 0);
  assert.ok(newIndex < sectionsIndex);
  assert.ok(sectionsIndex < officeIndex);
  assert.ok(officeIndex < switchIndex);
  assert.ok(switchIndex < accountIndex);
});

test("login and full-page routes render without AppShell", () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.sessionStorage;
  const storage = memoryStorage();
  const location = { pathname: "/", search: "", href: "http://odos.local/", origin: "http://odos.local" };
  const windowStub = {
    location,
    history: { replaceState: () => undefined },
    fetch: globalThis.fetch,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  fhir.logout(storage);

  try {
    const login = renderToStaticMarkup(<App resolveRoles={async () => ({ roles: ["front-desk"] })} />);
    assert.match(login, /Email address/);
    assert.doesNotMatch(login, /data-testid="app-shell"/);

    for (const path of ["/setpassword/user/secret", "/oauth2/authorize", "/oauth2/grants"]) {
      location.pathname = path;
      const html = renderToStaticMarkup(<App />);
      assert.doesNotMatch(html, /data-testid="app-shell"/, path);
    }
  } finally {
    fhir.logout(storage);
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: originalStorage });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("the account Logout item clears the persisted session", async () => {
  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "session-token", expiresAt: Date.now() + 60_000 }));
  assert.equal(fhir.rehydrateSession(storage), true);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AppShell path="/settings/staff" roles={["practice-admin"]} homePath="/desk" side="desk" email="admin@example.test"><main /></AppShell>);
  });
  const logout = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Logout");
  assert.ok(logout);
  await act(async () => logout.props.onClick());
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
  assert.equal(fhir.authHeader(), undefined);
  renderer.unmount();
});

test("a rehydrated Medplum profile resolves the account email without changing auth state", async () => {
  const payload = btoa(JSON.stringify({ profile: "Practitioner/practitioner-1", scope: "openid" })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const calls: Array<[string, string]> = [];
  const email = await sessionEmailFromProfile(`Bearer header.${payload}.signature`, {
    async read(resourceType, id) {
      calls.push([resourceType, id]);
      return { resourceType: "Practitioner", id, telecom: [{ system: "email", value: "doctor@example.test" }] } as never;
    },
  });
  assert.equal(email, "doctor@example.test");
  assert.deepEqual(calls, [["Practitioner", "practitioner-1"]]);
});

test("Command-K focuses global patient search from a non-clinic page", async () => {
  const originalDocument = globalThis.document;
  let keydown: ((event: KeyboardEvent) => void) | undefined;
  let focused = false;
  const documentStub = {
    addEventListener: (type: string, listener: EventListener) => { if (type === "keydown") keydown = listener as (event: KeyboardEvent) => void; },
    removeEventListener: () => undefined,
  } as unknown as Document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentStub });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <AppShell path="/billing/claims/worklist" roles={["front-desk"]} homePath="/desk" side="desk" email="desk@example.test"><main /></AppShell>,
        { createNodeMock: (element) => element.type === "input" ? { focus: () => { focused = true; } } : null },
      );
    });
    assert.ok(keydown);
    let prevented = false;
    await act(async () => keydown?.({ metaKey: true, ctrlKey: false, key: "k", preventDefault: () => { prevented = true; } } as KeyboardEvent));
    assert.equal(focused, true);
    assert.equal(prevented, true);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("Desk and Clinic homes have exactly one header after their local headers are folded", () => {
  const desk = renderToStaticMarkup(<AppShell path="/desk" roles={["front-desk"]} homePath="/desk" side="desk" email="desk@example.test"><DeskHome /></AppShell>);
  const clinic = renderToStaticMarkup(<AppShell path="/clinic" roles={["clinician"]} homePath="/clinic" side="clinic" email="doctor@example.test"><ClinicHome /></AppShell>);
  assert.equal((desk.match(/<header class="odos-desk-topbar/g) ?? []).length, 1);
  assert.equal((clinic.match(/<header class="odos-desk-topbar/g) ?? []).length, 1);
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}
