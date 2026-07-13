import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginScreen, PASSWORD_RESET_CONFIRMATION, requestPasswordReset, submitLogin } from "../src/scenes/LoginScreen";
import { PasswordResetTransportError } from "../src/lib/auth-api";
import { fetchWhoAmI } from "../src/lib/practice-roles";
import { submitSetPassword } from "../src/scenes/SetPasswordScreen";
import { CLINIC_PATH, DESK_CARD_STORAGE_KEY, DESK_HOME_PATH, DeskHome, displayStat, loadDeskCardIds, reorderDeskCards, sanitizeDeskCardIds } from "../src/scenes/DeskHome";
import type { DeskSummary } from "../src/lib/desk-summary";

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

test("set-password submit passes the email-link credentials and new password", async () => {
  const calls: unknown[][] = [];
  await submitSetPassword({
    id: "user-id",
    secret: "email-secret",
    password: "new-password",
    confirmPassword: "new-password",
    setPassword: async (...args) => { calls.push(args); },
  });
  assert.deepEqual(calls, [["user-id", "email-secret", "new-password"]]);
});

test("set-password submit surfaces server failures", async () => {
  await assert.rejects(() => submitSetPassword({
    id: "user-id",
    secret: "expired-secret",
    password: "new-password",
    confirmPassword: "new-password",
    setPassword: async () => { throw new Error("FHIR 400 Bad Request: Reset link expired"); },
  }), /Reset link expired/);
});

test("forgot-password confirmation is neutral on success and failure", async () => {
  const success = await requestPasswordReset("known@example.test", async () => undefined);
  const failure = await requestPasswordReset("unknown@example.test", async () => {
    throw new Error("Account not found");
  });
  assert.equal(success, PASSWORD_RESET_CONFIRMATION);
  assert.equal(failure, PASSWORD_RESET_CONFIRMATION);
});

test("forgot-password transport failure does not claim an email is coming", async () => {
  await assert.rejects(
    () => requestPasswordReset("person@example.test", async () => {
      throw new PasswordResetTransportError(new Error("connection refused"));
    }),
    /could not reach ODOS/,
  );
});

test("whoami no-role errors render the server detail instead of only the machine code", async () => {
  await assert.rejects(
    () => fetchWhoAmI(async () => new Response(JSON.stringify({
      error: "no-practice-role",
      detail: "Account person@example.test has no practice role. An administrator must grant one.",
    }), { status: 403, headers: { "Content-Type": "application/json" } })),
    /Account person@example.test has no practice role/,
  );
});

test("Desk home is independent from the cockpit and Clinic opens the existing flow in a new tab", () => {
  const html = renderToStaticMarkup(<DeskHome />);
  assert.match(html, /The Desk/);
  assert.match(html, new RegExp(`href="${CLINIC_PATH}"[^>]*target="_blank"`));
  assert.match(html, /Sections/);
  assert.match(html, /Customize/);
  assert.match(html, /Electronic remits/);
  assert.match(html, /href="\/billing\/statements"/);
});

test("Desk card configuration sanitizes and reorders only catalog cards", () => {
  assert.deepEqual(sanitizeDeskCardIds(["claims", "claims", "bogus", "schedule"]), ["claims", "schedule"]);
  assert.deepEqual(reorderDeskCards(["schedule", "attention", "claims"], "claims", "schedule"), ["claims", "schedule", "attention"]);
});

test("Desk customization persists reorder, remove, add-back, and Reset for all ten cards", () => {
  const defaults = loadDeskCardIds(undefined);
  assert.equal(defaults.length, 10);
  assert.ok(defaults.includes("front-line"));
  assert.ok(defaults.includes("office"));
  const reordered = reorderDeskCards(defaults, "statements", "schedule");
  const removed = reordered.filter((id) => id !== "front-line");
  const addedBack = [...removed, "front-line"];
  const storage = { getItem: (key: string) => key === DESK_CARD_STORAGE_KEY ? JSON.stringify(addedBack) : null };
  assert.deepEqual(loadDeskCardIds(storage), addedBack);
  assert.deepEqual(sanitizeDeskCardIds(defaults), defaults);
});

test("Front Line without a CommsProvider renders one wiring panel and no zero placeholders", () => {
  const html = renderToStaticMarkup(<DeskHome initialSummary={emptyDeskSummary()} />);
  const frontLine = html.match(/Front Line[\s\S]*?Open desk inbox →/)?.[0] ?? "";
  assert.match(frontLine, /Comms counts arrive with the GHL adapter — Phase 3b/);
  assert.doesNotMatch(frontLine, />0</);
  assert.doesNotMatch(frontLine, /Need reply/);
});

test("Needs attention renders the exact all-clear state when every target is met", () => {
  const html = renderToStaticMarkup(<DeskHome initialSummary={emptyDeskSummary()} />);
  assert.match(html, /All clear — nothing needs you\./);
});

test("Desk statement date-time formatting degrades malformed values to an em dash", () => {
  assert.equal(displayStat("not-a-date", "date-time"), "—");
});

function emptyDeskSummary(): DeskSummary {
  const n = { value: 0, tone: "ok" as const };
  const off = { value: null, tone: "off" as const, unavailableReason: "Not wired." };
  return {
    cards: {
      schedule: { today: n, confirmed: n, checkedIn: { value: 0, tone: "info" }, webRequests: n, agenda: [] },
      attention: { items: [] },
      frontLine: { available: false, message: "Comms counts arrive with the GHL adapter — Phase 3b", needsReply: off, missedCalls: off, voicemails: off, urgent: off, messages: [] },
      pendingRx: { spectacle: { value: 0, tone: "info" }, contactLens: off, labOrdersUnsent: off, oldestWaiting: { value: null, tone: "off" } },
      productPickup: { openOrders: { value: 0, tone: "info" }, atLab: { value: 0, tone: "info" }, readyNotNotified: off, awaitingPickup: { value: 0, tone: "info" } },
      claims: { failed: n, inProcess: { value: 0, tone: "info" }, paperQueue: off, heldCents: n, lastTransmission: { value: null, tone: "off" } },
      payments: { unappliedCount: n, unappliedCents: n, patientCreditsOpen: n, patientOpenBalanceCents: { value: 0, tone: "info" }, terminalMode: { value: "LIVE", tone: "ok" } },
      remits: { waitingToPost: n, unpostedCents: n },
      statements: { available: true, cadence: { value: "Weekly · Wednesdays recommended", tone: "info" }, invalidRejects: n, lastStatement: { value: null, tone: "off" } },
    },
    pulse: { itemsNeedingYou: 0, everythingElseAtTarget: true, lastClaimTransmission: null, lastClaimTransmissionTone: "off" },
  };
}
