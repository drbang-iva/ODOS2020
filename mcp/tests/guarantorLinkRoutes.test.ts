import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

test("S1: all five operation routes require an authenticated staff caller", async () => {
  const { registerGuarantorRoutes } = await import("../src/clinic/guarantor-routes.js");
  const app = express(); app.use(express.json()); let identities = 0;
  registerGuarantorRoutes(app, { authenticateService: async () => {}, authenticate: async () => null,
    serviceFhir: { getAuthenticatedProfileReference: async () => { identities++; return "ClientApplication/service"; } } as never,
    recordAudit: async () => {} });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/guarantors/link-operations`;
    for (const [method, path] of [["POST", "/preview"], ["POST", ""], ["GET", "/synthetic"], ["POST", "/synthetic/complete"], ["POST", "/synthetic/correct"]]) {
      const response = await fetch(`${base}${path}`, { method }); assert.equal(response.status, 401, path);
    }
    assert.equal(identities, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("S1 rate limit: all five routes share a budget before service or staff authentication", async () => {
  const { registerGuarantorRoutes } = await import("../src/clinic/guarantor-routes.js");
  const app = express(); let serviceChecks = 0, staffChecks = 0;
  registerGuarantorRoutes(app, { authenticateService: async () => { serviceChecks++; }, authenticate: async () => { staffChecks++; return null; },
    serviceFhir: {} as never, recordAudit: async () => {} });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/guarantors/link-operations`;
    for (let i = 0; i < 120; i++) assert.equal((await fetch(`${base}/synthetic`)).status, 401);
    for (const [method, path] of [["POST", "/preview"], ["POST", ""], ["GET", "/synthetic"], ["POST", "/synthetic/complete"], ["POST", "/synthetic/correct"]]) {
      const response = await fetch(`${base}${path}`, { method }); assert.equal(response.status, 429, path);
      assert.ok(Number(response.headers.get("retry-after")) > 0);
    }
    assert.equal(serviceChecks, 120); assert.equal(staffChecks, 120);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
