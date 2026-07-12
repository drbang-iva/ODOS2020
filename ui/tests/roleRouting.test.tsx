import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clinicViewAfterNavigation,
  clinicViewFromSearch,
  clinicRouteView,
  defaultHomePath,
  RoleSwitchPill,
  RouteSwitch,
  shouldResetClinicView,
} from "../src/App";
import {
  fetchWhoAmI,
  PRACTICE_ROLE_IDS,
  resolveSessionRoles,
  type PracticeRoleId,
} from "../src/lib/practice-roles";
import { CLINIC_PATH, DESK_HOME_PATH } from "../src/scenes/DeskHome";
import type { ViewState } from "../src/lib/view-state";

test("every non-empty practice-role combination routes from its whoami response to the correct home", async () => {
  for (let mask = 1; mask < 2 ** PRACTICE_ROLE_IDS.length; mask += 1) {
    const mockedRoles = PRACTICE_ROLE_IDS.filter((_, index) => mask & (1 << index));
    const fetchImpl = async () => new Response(JSON.stringify({ roles: mockedRoles }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const whoami = await fetchWhoAmI(fetchImpl as typeof fetch);
    const expected = mockedRoles.includes("clinician") || mockedRoles.includes("aesthetics-provider")
      ? CLINIC_PATH
      : DESK_HOME_PATH;
    assert.equal(defaultHomePath(whoami.roles), expected, mockedRoles.join(" + "));
  }
});

test("clinician plus front-desk lands in Clinic and renders a new-tab switch pill on both sides", () => {
  const roles: PracticeRoleId[] = ["clinician", "front-desk"];
  assert.equal(defaultHomePath(roles), CLINIC_PATH);

  const clinic = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path={CLINIC_PATH} roles={roles} />);
  const desk = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path={DESK_HOME_PATH} roles={roles} />);
  assert.match(clinic, /Switch to Desk/);
  assert.match(desk, /Switch to Clinic/);

  const calls: unknown[][] = [];
  const pill = RoleSwitchPill({ target: DESK_HOME_PATH, open: ((...args: unknown[]) => {
    calls.push(args);
    return null;
  }) as typeof window.open });
  pill.props.onClick();
  assert.deepEqual(calls, [[DESK_HOME_PATH, "_blank", "noopener,noreferrer"]]);
});

test("single-role users do not render a cross-side switch pill", () => {
  const clinic = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path={CLINIC_PATH} roles={["clinician"]} />);
  const desk = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path={DESK_HOME_PATH} roles={["front-desk"]} />);
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
