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
    assert.deepEqual(searched, ["Appointment", "Task", "Claim", "ClaimResponse", "PaymentReconciliation", "Invoice"]);
    assert.equal(serviceAuthCalls, 2);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});
