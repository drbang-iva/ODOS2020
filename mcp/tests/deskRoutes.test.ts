import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Resource } from "@medplum/fhirtypes";
import express from "express";
import { registerDeskRoutes } from "../src/desk/desk-routes.js";

test("GET /desk/summary authenticates once and composes the screen from server-side FHIR reads", async () => {
  const searched: string[] = [];
  const fhir = {
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => {
      searched.push(String(resourceType));
      return { resourceType: "Bundle", type: "searchset" };
    },
  };
  let serviceAuthCalls = 0;
  const app = express();
  registerDeskRoutes(app, {
    authenticateService: async () => { serviceAuthCalls += 1; },
    authenticate: async (header) => header === "Bearer good"
      ? { staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir: fhir as never }
      : null,
    resolveRoles: async () => ["front-desk"],
    terminalMode: "TEST MODE",
    now: () => "2026-07-11T14:00:00.000Z",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/desk/summary`);
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`http://127.0.0.1:${port}/desk/summary`, { headers: { Authorization: "Bearer good" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { cards?: Record<string, unknown>; pulse?: unknown };
    assert.deepEqual(Object.keys(body.cards ?? {}), ["schedule", "attention", "frontLine", "pendingRx", "productPickup", "claims", "payments", "remits", "statements"]);
    assert.ok(body.pulse);
    assert.deepEqual(searched, ["Appointment", "Task", "Task", "Task", "Task", "Claim", "ClaimResponse", "PaymentReconciliation", "Invoice"]);
    assert.equal(serviceAuthCalls, 2);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("GET /desk/summary keeps other cards available when one scoped Task category exceeds a page", async () => {
  const taskSearches: Array<Record<string, string>> = [];
  const fhir = {
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string>): Promise<Bundle<T>> => {
      if (resourceType === "Task") {
        taskSearches.push(params);
        if (params.code === "https://osod.dev/fhir/CodeSystem/optical-order-type|") {
          return {
            resourceType: "Bundle",
            type: "searchset",
            total: 1_001,
            link: [{ relation: "next", url: "Task?_page=2" }],
          } as Bundle<T>;
        }
      }
      return { resourceType: "Bundle", type: "searchset" };
    },
  };
  const app = express();
  registerDeskRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir: fhir as never }),
    resolveRoles: async () => ["front-desk"],
    terminalMode: "TEST MODE",
    now: () => "2026-07-11T14:00:00.000Z",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/desk/summary`, { headers: { Authorization: "Bearer good" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { cards?: { pendingRx?: { spectacle?: { value?: number | null; unavailableReason?: string } }; statements?: { available?: boolean }; payments?: unknown } };
    assert.equal(body.cards?.statements?.available, true);
    assert.ok(body.cards?.payments);
    assert.equal(body.cards?.pendingRx?.spectacle?.value, null);
    assert.match(body.cards?.pendingRx?.spectacle?.unavailableReason ?? "", /exceed the Desk card read limit/);
    assert.equal(taskSearches.length, 4);
    assert.ok(taskSearches.every((params) => Boolean(params.code)));
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("GET /desk/whoami returns the authenticated staff member's practice-role tags", async () => {
  const app = express();
  registerDeskRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => null,
    resolveRoles: async (header) => header === "Bearer good" ? ["clinician", "front-desk"] : null,
    terminalMode: "TEST MODE",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/desk/whoami`);
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`http://127.0.0.1:${port}/desk/whoami`, { headers: { Authorization: "Bearer good" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { roles: ["clinician", "front-desk"] });
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});
