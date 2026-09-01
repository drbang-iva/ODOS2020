import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import {
  createLiveAuthorizationClients,
  loadRepoEnv,
  requireMedplumAdmin,
} from "./integration-helpers.js";

test("executeTransaction rolls back created entries when a later transaction entry fails", { timeout: 90_000 }, async (t) => {
  loadRepoEnv();

  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const credentials = requireMedplumAdmin(t, "transaction-atomicity");
  if (!credentials) {
    return;
  }
  const { email, password } = credentials;

  const { seederFhir: fhir } = await createLiveAuthorizationClients({ baseUrl, email, password });
  const marker = `atomicity-${Date.now()}`;

  const goodPatient: Patient = {
    resourceType: "Patient",
    identifier: [{ system: "https://odos2020.com/test/transaction-atomicity", value: marker }],
    name: [{ family: "AtomicityRollback", given: ["Good"] }],
  };
  const response = await fhir.executeTransaction({
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      { resource: goodPatient, request: { method: "POST", url: "Patient" } },
      {
        resource: {
          resourceType: "Binary",
          contentType: "application/json-patch+json",
          data: "W10=",
        } as never,
        request: { method: "PATCH", url: "NoSuchResource/rollback-test" },
      },
    ],
  });

  assert.equal(response.type, "transaction-response");
  assert.ok(
    response.entry?.some((entry) => entry.response?.status?.startsWith("4")),
    "Expected at least one failed transaction entry.",
  );

  const persisted = await fhir.search<Patient>("Patient", {
    identifier: `https://odos2020.com/test/transaction-atomicity|${marker}`,
    _count: "1",
  });
  assert.equal(persisted.entry?.length ?? 0, 0);
});
