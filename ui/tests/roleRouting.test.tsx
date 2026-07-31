import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  App,
  clinicViewAfterNavigation,
  clinicViewFromSearch,
  clinicRouteView,
  defaultHomePath,
  hasCrossSideAccess,
  openOtherSide,
  parseSetPasswordPath,
  RoleSwitchPill,
  RouteSwitch,
  shouldResetClinicView,
  type RouteSwitchProps,
} from "../src/App";
import { fhir, SESSION_STORAGE_KEY } from "../src/lib/fhir";
import { AppShell } from "../src/components/AppShell";
import { LoginScreen } from "../src/scenes/LoginScreen";
import { SetPasswordScreen } from "../src/scenes/SetPasswordScreen";
import {
  fetchWhoAmI,
  PRACTICE_ROLE_IDS,
  resolveSessionRoles,
  type PracticeRoleId,
} from "../src/lib/practice-roles";
import { CLINIC_PATH, DESK_HOME_PATH } from "../src/scenes/DeskHome";
import type { ViewState } from "../src/lib/view-state";
import { useViewState } from "../src/lib/view-state";

function RouteProbe(_props: RouteSwitchProps) {
  return <main>Route probe</main>;
}

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

function responseAt(url: string, status = 401): Response {
  const response = new Response(null, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("set-password email links route before the authenticated app", () => {
  const originalWindow = globalThis.window;
  const windowStub = { location: { pathname: "/setpassword/user%2Did/secret%2Ftoken" } } as Window & typeof globalThis;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  try {
    const route = App() as React.ReactElement;
    assert.equal(route.type, SetPasswordScreen);
    assert.deepEqual(route.props, { id: "user-id", secret: "secret/token" });
    assert.deepEqual(parseSetPasswordPath("/setpassword/id/secret"), { id: "id", secret: "secret" });
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("every non-empty practice-role combination routes from its whoami response to the correct home", async () => {
  for (let mask = 1; mask < 2 ** PRACTICE_ROLE_IDS.length; mask += 1) {
    const mockedRoles = PRACTICE_ROLE_IDS.filter((_, index) => mask & (1 << index));
    const fetchImpl = async () => new Response(JSON.stringify({ roles: mockedRoles }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const whoami = await fetchWhoAmI(fetchImpl as typeof fetch);
    const expected = mockedRoles.includes("front-desk") || mockedRoles.includes("practice-admin")
      ? DESK_HOME_PATH
      : mockedRoles.includes("clinician") || mockedRoles.includes("aesthetics-provider")
        ? CLINIC_PATH
        : DESK_HOME_PATH;
    assert.equal(defaultHomePath(whoami.roles), expected, mockedRoles.join(" + "));
  }
});

test("entry routing follows the Desk-wins precedence matrix", () => {
  const cases: Array<[PracticeRoleId[], typeof CLINIC_PATH | typeof DESK_HOME_PATH]> = [
    [["front-desk"], DESK_HOME_PATH],
    [["practice-admin"], DESK_HOME_PATH],
    [["clinician"], CLINIC_PATH],
    [["aesthetics-provider"], CLINIC_PATH],
    [["clinician", "front-desk", "practice-admin"], DESK_HOME_PATH],
    [["clinician", "front-desk"], DESK_HOME_PATH],
    [[], DESK_HOME_PATH],
  ];

  for (const [roles, expected] of cases) {
    assert.equal(defaultHomePath(roles), expected, roles.join(" + ") || "roleless");
  }
});

test("cross-side access requires at least one Desk role and one Clinic role", () => {
  assert.equal(hasCrossSideAccess(["clinician", "front-desk"]), true);
  assert.equal(hasCrossSideAccess(["practice-admin", "clinician"]), true);
  assert.equal(hasCrossSideAccess(["front-desk"]), false);
  assert.equal(hasCrossSideAccess(["clinician"]), false);
  assert.equal(hasCrossSideAccess([]), false);
});

test("cross-side users switch between Desk and Clinic in the same tab", () => {
  const roles: PracticeRoleId[] = ["clinician", "front-desk"];
  assert.equal(defaultHomePath(roles), DESK_HOME_PATH);

  const clinic = renderToStaticMarkup(<AppShell path={CLINIC_PATH} roles={roles} homePath={DESK_HOME_PATH} side="clinic" email="doctor@example.test" switchPill={<RoleSwitchPill target={DESK_HOME_PATH} />}><RouteSwitch view={{ kind: "picker" }} path={CLINIC_PATH} roles={roles} /></AppShell>);
  const desk = renderToStaticMarkup(<AppShell path={DESK_HOME_PATH} roles={roles} homePath={DESK_HOME_PATH} side="desk" email="doctor@example.test" switchPill={<RoleSwitchPill target={CLINIC_PATH} />}><RouteSwitch view={{ kind: "picker" }} path={DESK_HOME_PATH} roles={roles} /></AppShell>);
  assert.match(clinic, /Switch to Desk/);
  assert.match(desk, /Switch to Clinic/);

  const originalWindow = globalThis.window;
  const pushed: string[] = [];
  const events: string[] = [];
  const windowStub = {
    history: { pushState: (_state: unknown, _title: string, path: string) => pushed.push(path) },
    dispatchEvent: (event: Event) => { events.push(event.type); return true; },
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  try {
    openOtherSide(CLINIC_PATH);
    assert.deepEqual(pushed, [CLINIC_PATH]);
    assert.deepEqual(events, ["popstate"]);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("App rehydrates an unexpired session on boot", async () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.sessionStorage;
  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    accessToken: "persisted-access-token",
    refreshToken: "persisted-refresh-token",
    expiresAt: Date.now() + 60_000,
  }));
  const location = { pathname: DESK_HOME_PATH, search: "" };
  const windowStub = {
    location,
    history: {
      replaceState: (_state: unknown, _title: string, path: string) => { location.pathname = path; },
    },
    fetch: globalThis.fetch,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<App
        resolveRoles={async () => ({ roles: ["front-desk"] })}
        RouteComponent={RouteProbe}
      />);
      await Promise.resolve();
    });
    assert.equal(fhir.authHeader(), "Bearer persisted-access-token");
    assert.equal(renderer.root.findAllByType(LoginScreen).length, 0);
    assert.equal(renderer.root.findByType(RouteProbe).props.path, DESK_HOME_PATH);
  } finally {
    if (renderer) act(() => renderer.unmount());
    fhir.logout(storage);
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: originalStorage });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("logout and an authenticated intercepted 401 clear the persisted session", async () => {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://practice.example.test/desk", origin: "https://practice.example.test" } },
  });
  const storage = memoryStorage();
  const seedSession = () => {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      accessToken: "session-token",
      expiresAt: Date.now() + 60_000,
    }));
    assert.equal(fhir.rehydrateSession(storage), true);
  };

  seedSession();
  fhir.logout(storage);
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
  assert.equal(fhir.authHeader(), undefined);

  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    accessToken: "expired-token",
    expiresAt: Date.now() - 1,
  }));
  assert.equal(fhir.rehydrateSession(storage), false);
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);

  seedSession();
  let cleared = 0;
  const stopListening = fhir.onSessionCleared(() => { cleared += 1; });
  const host = { fetch: async (..._args: Parameters<typeof fetch>) => responseAt("https://practice.example.test/any-api") as Promise<Response> };
  const stopIntercepting = fhir.interceptUnauthorizedResponses(host);
  try {
    const response = await host.fetch("/any-api", { headers: { Authorization: "Bearer session-token" } });
    assert.equal(response.status, 401);
    assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
    assert.equal(fhir.authHeader(), undefined);
    assert.equal(cleared, 1);
  } finally {
    stopIntercepting();
    stopListening();
    fhir.logout(storage);
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("an authenticated cross-origin 401 cannot clear the active session", async () => {
  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    accessToken: "session-token",
    expiresAt: Date.now() + 60_000,
  }));
  assert.equal(fhir.rehydrateSession(storage), true);
  const host = { fetch: async (..._args: Parameters<typeof fetch>) => new Response(null, { status: 401 }) as Promise<Response> };
  const stopIntercepting = fhir.interceptUnauthorizedResponses(host);
  try {
    const response = await host.fetch("https://remote.example.test/commercial-engine", {
      headers: { Authorization: "Bearer session-token" },
    });
    assert.equal(response.status, 401);
    assert.notEqual(storage.getItem(SESSION_STORAGE_KEY), null);
    assert.equal(fhir.authHeader(), "Bearer session-token");
  } finally {
    stopIntercepting();
    fhir.logout(storage);
  }
});

test("a same-origin request redirected to a cross-origin 401 cannot clear the active session", async () => {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://practice.example.test/desk", origin: "https://practice.example.test" } },
  });
  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    accessToken: "session-token",
    expiresAt: Date.now() + 60_000,
  }));
  assert.equal(fhir.rehydrateSession(storage), true);
  const host = { fetch: async (..._args: Parameters<typeof fetch>) => responseAt("https://remote.example.test/login") as Promise<Response> };
  const stopIntercepting = fhir.interceptUnauthorizedResponses(host);
  try {
    const response = await host.fetch("/fhir/R4/Patient", {
      headers: { Authorization: "Bearer session-token" },
    });
    assert.equal(response.status, 401);
    assert.equal(response.url, "https://remote.example.test/login");
    assert.notEqual(storage.getItem(SESSION_STORAGE_KEY), null);
    assert.equal(fhir.authHeader(), "Bearer session-token");
  } finally {
    stopIntercepting();
    fhir.logout(storage);
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("URL normalization and cross-realm shapes cannot misclassify cross-origin requests", async () => {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://practice.example.test/desk", origin: "https://practice.example.test" } },
  });
  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    accessToken: "session-token",
    expiresAt: Date.now() + 60_000,
  }));
  assert.equal(fhir.rehydrateSession(storage), true);
  const host = { fetch: async (..._args: Parameters<typeof fetch>) => responseAt("https://practice.example.test/api") as Promise<Response> };
  const stopIntercepting = fhir.interceptUnauthorizedResponses(host);
  const crossRealmUrl = Object.assign(Object.create(null) as object, { href: "https://remote.example.test/api" }) as URL;
  const inputs: Array<RequestInfo | URL> = [
    " https://remote.example.test/api",
    "\\\\remote.example.test\\api",
    crossRealmUrl,
  ];
  try {
    for (const input of inputs) {
      const response = await host.fetch(input, { headers: { Authorization: "Bearer session-token" } });
      assert.equal(response.status, 401);
      assert.notEqual(storage.getItem(SESSION_STORAGE_KEY), null);
      assert.equal(fhir.authHeader(), "Bearer session-token");
    }
  } finally {
    stopIntercepting();
    fhir.logout(storage);
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("an unauthenticated 401 cannot clear a different active session", async () => {
  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    accessToken: "session-token",
    expiresAt: Date.now() + 60_000,
  }));
  assert.equal(fhir.rehydrateSession(storage), true);
  const host = { fetch: async (..._args: Parameters<typeof fetch>) => new Response(null, { status: 401 }) as Promise<Response> };
  const stopIntercepting = fhir.interceptUnauthorizedResponses(host);
  try {
    const response = await host.fetch("/public-api");
    assert.equal(response.status, 401);
    assert.notEqual(storage.getItem(SESSION_STORAGE_KEY), null);
    assert.equal(fhir.authHeader(), "Bearer session-token");
  } finally {
    stopIntercepting();
    fhir.logout(storage);
  }
});

test("an authenticated Request with an explicit empty header override cannot clear the session on 401", async () => {
  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    accessToken: "session-token",
    expiresAt: Date.now() + 60_000,
  }));
  assert.equal(fhir.rehydrateSession(storage), true);
  const host = { fetch: async (..._args: Parameters<typeof fetch>) => new Response(null, { status: 401 }) as Promise<Response> };
  const stopIntercepting = fhir.interceptUnauthorizedResponses(host);
  try {
    const request = new Request("http://localhost/private", {
      headers: { Authorization: "Bearer session-token" },
    });
    const response = await host.fetch(request, { headers: {} });
    assert.equal(response.status, 401);
    assert.notEqual(storage.getItem(SESSION_STORAGE_KEY), null);
    assert.equal(fhir.authHeader(), "Bearer session-token");
  } finally {
    stopIntercepting();
    fhir.logout(storage);
  }
});

test("single-role users do not render a cross-side switch pill", () => {
  const clinic = renderToStaticMarkup(<AppShell path={CLINIC_PATH} roles={["clinician"]} homePath={CLINIC_PATH} side="clinic" email="doctor@example.test"><RouteSwitch view={{ kind: "picker" }} path={CLINIC_PATH} roles={["clinician"]} /></AppShell>);
  const desk = renderToStaticMarkup(<AppShell path={DESK_HOME_PATH} roles={["front-desk"]} homePath={DESK_HOME_PATH} side="desk" email="desk@example.test"><RouteSwitch view={{ kind: "picker" }} path={DESK_HOME_PATH} roles={["front-desk"]} /></AppShell>);
  assert.doesNotMatch(clinic, /Switch to/);
  assert.doesNotMatch(desk, /Switch to/);
});

test("practice roles resolve only once for the same bearer-token session", async () => {
  let calls = 0;
  const load = async () => {
    calls += 1;
    return { roles: ["front-desk" as const] };
  };
  const first = resolveSessionRoles("Bearer session-a", load);
  const second = resolveSessionRoles("Bearer session-a", load);
  assert.equal(first, second);
  assert.deepEqual(await second, { roles: ["front-desk"] });
  assert.equal(calls, 1);
});

test("leaving the Clinic route resets its patient view while in-Clinic view changes do not", () => {
  assert.equal(shouldResetClinicView(CLINIC_PATH, "/billing/claims/worklist"), true);
  assert.equal(shouldResetClinicView(CLINIC_PATH, CLINIC_PATH), false);
  assert.equal(shouldResetClinicView("/clinic/patients", CLINIC_PATH), true);
  assert.equal(shouldResetClinicView(DESK_HOME_PATH, CLINIC_PATH), false);
});

test("selecting at Clinic patient search then navigating home renders ClinicHome, not the stale Director", () => {
  const selected: ViewState = { kind: "director", patientId: "patient-1" };
  const reset = clinicViewAfterNavigation("/clinic/patients", CLINIC_PATH, selected);
  const clinic = renderToStaticMarkup(<RouteSwitch view={reset} path={CLINIC_PATH} roles={["clinician"]} />);
  assert.deepEqual(reset, { kind: "picker" });
  assert.match(clinic, /The Clinic/);
  assert.doesNotMatch(clinic, /Loading patient/);
});

test("Clinic initial URLs select a patient or encounter while an empty query keeps the home", () => {
  assert.deepEqual(clinicViewFromSearch("?patientId=patient-1", { kind: "picker" }), {
    kind: "overview",
    patientId: "patient-1",
  });
  assert.deepEqual(clinicViewFromSearch("?patientId=patient-1&encounterId=encounter-1", { kind: "picker" }), {
    kind: "encounter",
    patientId: "patient-1",
    encounterId: "encounter-1",
  });
  assert.deepEqual(clinicViewFromSearch("", { kind: "picker" }), { kind: "picker" });

  const patientRoute = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path={CLINIC_PATH} search="?patientId=patient-1" />,
  );
  const emptyRoute = renderToStaticMarkup(
    <RouteSwitch view={{ kind: "picker" }} path={CLINIC_PATH} search="" />,
  );
  assert.match(patientRoute, /Loading patient/);
  assert.doesNotMatch(patientRoute, /Today&#x27;s flow/);
  assert.match(emptyRoute, /Today&#x27;s flow/);

  assert.deepEqual(
    clinicRouteView("?patientId=patient-1", { kind: "director", patientId: "patient-2" }),
    { kind: "director", patientId: "patient-2" },
  );
});

test("a Clinic deep link stays on the chart after front-desk-only role routing", async () => {
  const originalWindow = globalThis.window;
  const location = { pathname: CLINIC_PATH, search: "?patientId=patient-1" };
  const windowStub = {
    location,
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        const next = new URL(url, "http://localhost");
        location.pathname = next.pathname;
        location.search = next.search;
      },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  useViewState.setState({ view: { kind: "picker" } });

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<App
        resolveRoles={async () => ({ roles: ["front-desk"] })}
        login={async () => undefined}
        RouteComponent={RouteProbe}
      />);
    });
    await act(async () => {
      renderer.root.findByType(LoginScreen).props.onAuthenticated();
      await Promise.resolve();
    });

    const route = renderer.root.findByType(RouteProbe);
    assert.equal(defaultHomePath(["front-desk"]), DESK_HOME_PATH);
    assert.equal(route.props.path, CLINIC_PATH);
    assert.deepEqual(route.props.view, { kind: "overview", patientId: "patient-1" });
    assert.deepEqual(location, { pathname: CLINIC_PATH, search: "?patientId=patient-1" });
  } finally {
    if (renderer) act(() => renderer.unmount());
    useViewState.setState({ view: { kind: "picker" } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("logout and re-login route from the current address instead of the first bootstrap address", async () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.sessionStorage;
  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    accessToken: "persisted-access-token",
    expiresAt: Date.now() + 60_000,
  }));
  const location = { pathname: DESK_HOME_PATH, search: "" };
  const windowStub = {
    location,
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        const next = new URL(url, "http://localhost");
        location.pathname = next.pathname;
        location.search = next.search;
      },
    },
    fetch: globalThis.fetch,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<App
        resolveRoles={async () => ({ roles: ["practice-admin"] })}
        login={async () => undefined}
        RouteComponent={RouteProbe}
      />);
      await Promise.resolve();
    });
    assert.equal(renderer.root.findByType(RouteProbe).props.path, DESK_HOME_PATH);

    location.pathname = "/settings/packages";
    await act(async () => fhir.logout(storage));
    assert.equal(renderer.root.findAllByType(LoginScreen).length, 1);
    await act(async () => {
      renderer.root.findByType(LoginScreen).props.onAuthenticated();
      await Promise.resolve();
    });
    assert.equal(renderer.root.findByType(RouteProbe).props.path, "/settings/packages");
    assert.deepEqual(location, { pathname: "/settings/packages", search: "" });
  } finally {
    if (renderer) act(() => renderer.unmount());
    fhir.logout(storage);
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: originalStorage });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("authenticated bootstrap preserves non-root hard-reload routes", async () => {
  const originalWindow = globalThis.window;
  try {
    for (const requestedPath of [
      "/settings/packages",
      "/billing/claims/worklist",
      "/financials/practice/margins",
    ]) {
      const location = { pathname: requestedPath, search: "" };
      const windowStub = {
        location,
        history: {
          replaceState: (_state: unknown, _title: string, url: string) => {
            const next = new URL(url, "http://localhost");
            location.pathname = next.pathname;
            location.search = next.search;
          },
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        setInterval: () => 1,
        clearInterval: () => undefined,
      } as unknown as Window & typeof globalThis;
      Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
      let renderer!: ReactTestRenderer;
      try {
        await act(async () => {
          renderer = create(<App
            resolveRoles={async () => ({ roles: ["practice-admin", "front-desk"] })}
            login={async () => undefined}
            RouteComponent={RouteProbe}
          />);
        });
        await act(async () => {
          renderer.root.findByType(LoginScreen).props.onAuthenticated();
          await Promise.resolve();
        });
        assert.equal(renderer.root.findByType(RouteProbe).props.path, requestedPath);
        assert.equal(location.pathname, requestedPath);
      } finally {
        if (renderer) act(() => renderer.unmount());
      }
    }
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
