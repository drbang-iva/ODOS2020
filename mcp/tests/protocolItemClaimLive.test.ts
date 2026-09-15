import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Basic } from "@medplum/fhirtypes";
import {
  protocolItemClaimIdentifier,
  PROTOCOL_BASIC_CODES,
  ProtocolBasicStore,
  type ProtocolFhirClient,
} from "../src/clinical-graph/protocol-store.js";
import type { ProtocolApplication } from "../src/clinical-graph/protocol-types.js";
import { createAuthenticatedFhirClient, requireMedplumAdmin } from "./integration-helpers.js";

const baseUrl = process.env.MEDPLUM_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8103";

test("Medplum conditional create gives concurrent protocol-item claims one application", async (t) => {
  const credentials = requireMedplumAdmin(t, "protocolItemClaimLive");
  if (!credentials) return;
  const { fhir, accessToken } = await createAuthenticatedFhirClient({ baseUrl, ...credentials });
  const runId = randomUUID();
  const store = new ProtocolBasicStore<ProtocolApplication>(fhir, PROTOCOL_BASIC_CODES.protocolApplication);
  const claim = protocolItemClaimIdentifier(`encounter-${runId}`, "protocol-race", "order-gonioscopy");
  const application = (id: string): ProtocolApplication => ({
    id,
    encounterId: `encounter-${runId}`,
    patientId: `patient-${runId}`,
    protocolId: "protocol-race",
    protocolVersion: 1,
    appliedBy: "Practitioner/synthetic",
    appliedAt: "2026-09-14T20:00:00.000Z",
    stackedWith: [],
    dispositions: [{ itemKey: "order-gonioscopy", outcome: "applied-default" }],
    dedupResolutions: [],
    undoState: "active",
    confirmed: false,
  });

  const results = await Promise.all([
    store.createConditional(application(`claim-a-${runId}`), claim),
    store.createConditional(application(`claim-b-${runId}`), claim),
  ]);
  const createdId = results[0]?.id;
  const bundle = await fhir.search<Basic>("Basic", {
    identifier: `${claim.system}|${claim.value}`,
    _count: "10",
  });
  const claimedBasics = (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
  t.after(async () => {
    const resourceId = claimedBasics[0]?.id;
    if (!resourceId) return;
    const response = await fetch(`${baseUrl}/fhir/R4/Basic/${resourceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(response.ok, true, `Live claim cleanup returned ${response.status}.`);
  });

  assert.ok(createdId);
  assert.equal(results[1]?.id, createdId);
  assert.equal(claimedBasics.length, 1);
  const rows = (await store.list()).filter((candidate) =>
    candidate.id === `claim-a-${runId}` || candidate.id === `claim-b-${runId}`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, createdId);
});

test("Medplum rejects a stale protocol Basic update and the store reports lost ownership", async (t) => {
  const credentials = requireMedplumAdmin(t, "protocolItemClaimLive");
  if (!credentials) return;
  const { fhir, accessToken } = await createAuthenticatedFhirClient({ baseUrl, ...credentials });
  const runId = randomUUID();
  const store = new ProtocolBasicStore<ProtocolApplication>(fhir, PROTOCOL_BASIC_CODES.protocolApplication);
  const claim = protocolItemClaimIdentifier(`encounter-${runId}`, "protocol-stale", "order-gonioscopy");
  const application: ProtocolApplication = {
    id: `stale-claim-${runId}`,
    encounterId: `encounter-${runId}`,
    patientId: `patient-${runId}`,
    protocolId: "protocol-stale",
    protocolVersion: 1,
    appliedBy: "Practitioner/synthetic",
    appliedAt: "2026-09-14T20:00:00.000Z",
    stackedWith: [],
    dispositions: [{ itemKey: "order-gonioscopy", outcome: "applied-default" }],
    dedupResolutions: [],
    itemClaimLeaseExpiresAt: "2026-09-14T20:00:05.000Z",
    undoState: "active",
    confirmed: false,
  };
  await store.createConditional(application, claim);
  t.after(async () => {
    const bundle = await fhir.search<Basic>("Basic", {
      identifier: `${claim.system}|${claim.value}`,
      _count: "10",
    });
    for (const resource of (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : [])) {
      if (!resource.id) continue;
      const response = await fetch(`${baseUrl}/fhir/R4/Basic/${resource.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      assert.equal(response.ok, true, `Live stale-update cleanup returned ${response.status}.`);
    }
  });

  let staleStatus: number | undefined;
  const staleClient: ProtocolFhirClient = {
    search: <T extends Basic>(type: T["resourceType"], params?: Record<string, string>) =>
      fhir.search<T>(type, params),
    searchUrl: <T extends Basic>(url: string, type: T["resourceType"]) => fhir.searchUrl<T>(url, type),
    create: <T extends Basic>(resource: T, headers?: Record<string, string>) => fhir.create(resource, headers),
    async update<T extends Basic>(type: T["resourceType"], id: string, resource: T, headers?: Record<string, string>) {
      await fhir.update(type, id, resource, headers);
      try {
        return await fhir.update(type, id, resource, headers);
      } catch (error) {
        staleStatus = typeof error === "object" && error && "status" in error
          ? Number(error.status)
          : undefined;
        throw error;
      }
    },
    delete: (type: "Basic", id: string) => fhir.delete(type, id),
  };
  const staleStore = new ProtocolBasicStore<ProtocolApplication>(
    staleClient,
    PROTOCOL_BASIC_CODES.protocolApplication,
  );

  const saved = await staleStore.saveWithIdentifiersIfCurrent(
    { ...application, confirmed: true },
    [claim],
    (current) => current.undoState === "active" && !current.confirmed,
  );

  assert.equal(staleStatus, 412);
  assert.equal(saved, undefined);
});
