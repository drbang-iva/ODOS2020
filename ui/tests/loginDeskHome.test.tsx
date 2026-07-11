import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginScreen, submitLogin } from "../src/scenes/LoginScreen";
import { CLINIC_PATH, DESK_HOME_PATH, DeskHome, reorderDeskCards, sanitizeDeskCardIds } from "../src/scenes/DeskHome";

test("login screen renders real email and password fields with no environment credential fallback", () => {
  const html = renderToStaticMarkup(<LoginScreen returnTo={DESK_HOME_PATH} onAuthenticated={() => undefined} />);
  assert.match(html, /type="email"/);
  assert.match(html, /autoComplete="username"/);
  assert.match(html, /type="password"/);
  assert.match(html, /autoComplete="current-password"/);
  assert.doesNotMatch(html, /VITE_MEDPLUM_ADMIN/);
});

test("successful login navigates to the requested Desk home and authenticates", async () => {
  const events: string[] = [];
  await submitLogin({
    email: "admin@example.test",
    password: "valid",
    returnTo: DESK_HOME_PATH,
    login: async () => { events.push("login"); },
    navigate: (path) => events.push(`navigate:${path}`),
    onAuthenticated: () => events.push("authenticated"),
  });
  assert.deepEqual(events, ["login", `navigate:${DESK_HOME_PATH}`, "authenticated"]);
});

test("failed login never navigates or authenticates", async () => {
  const events: string[] = [];
  await assert.rejects(() => submitLogin({
    email: "admin@example.test",
    password: "invalid",
    returnTo: DESK_HOME_PATH,
    login: async () => { throw new Error("Invalid credentials"); },
    navigate: (path) => events.push(`navigate:${path}`),
    onAuthenticated: () => events.push("authenticated"),
  }), /Invalid credentials/);
  assert.deepEqual(events, []);
});

test("Desk home is independent from the cockpit and Clinic opens the existing flow in a new tab", () => {
  const html = renderToStaticMarkup(<DeskHome />);
  assert.match(html, /The Desk/);
  assert.match(html, new RegExp(`href="${CLINIC_PATH}"[^>]*target="_blank"`));
  assert.match(html, /Sections/);
  assert.match(html, /Customize/);
  assert.match(html, /Electronic remits/);
});

test("Desk card configuration sanitizes and reorders only catalog cards", () => {
  assert.deepEqual(sanitizeDeskCardIds(["claims", "claims", "bogus", "schedule"]), ["claims", "schedule"]);
  assert.deepEqual(reorderDeskCards(["schedule", "attention", "claims"], "claims", "schedule"), ["claims", "schedule", "attention"]);
});
