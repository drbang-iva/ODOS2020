import assert from "node:assert/strict";
import { test } from "node:test";
import { submitProfessionalClaim, type ProfessionalClaimInput } from "../../ui/src/lib/submit-claims.js";

const claim = { patientAccountNumber: "ODOS-CLAIM-900" } as ProfessionalClaimInput;

test("UI submit helper preserves the Claim.MD-default request body when no selector is supplied", async () => {
  let body = "";
  await submitProfessionalClaim(claim, {
    fetchImpl: (async (_url: URL | RequestInfo, init?: RequestInit) => {
      body = String(init?.body);
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(body, JSON.stringify({ claim }));
});

test("UI submit helper can explicitly select Stedi without changing the claim payload", async () => {
  let body = "";
  await submitProfessionalClaim(claim, {
    clearinghouse: "stedi",
    fetchImpl: (async (_url: URL | RequestInfo, init?: RequestInit) => {
      body = String(init?.body);
      return new Response('{"clearinghouse":"stedi"}', { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(body, JSON.stringify({ claim, clearinghouse: "stedi" }));
});

import type { Bundle, ChargeItem, Resource } from "@medplum/fhirtypes";
import { handleSubmitClaimRequest, type ClaimsHandlerDeps } from "../src/claims/claimmd-handlers.js";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import type { ProfessionalClaimInput as ServerClaimInput } from "../src/claims/claimmd-fhir.js";
import type { ClearinghouseAdapter } from "../src/claims/clearinghouse-adapter.js";
import { buildProcedureFeeDefinition } from "../src/clinical-graph/procedure-fee-schedule.js";
import { readFileSync, writeFileSync } from "node:fs";

function holdSubmitFixture(clearinghouse: "claimmd" | "stedi" = "claimmd") {
  const writes: Resource[] = [];
  const payloads: unknown[] = [];
  const audits: OdosAuditEventRecord[] = [];
  const stored: Resource[] = [buildProcedureFeeDefinition({ procedureConceptKey: "synthetic-photo", display: "Synthetic photograph", billingCode: "PHOTO1", interpretation: "fundus-photo" })];
  const charge = (code: string): ChargeItem & { diagnosisSequence: number[] } => ({
    resourceType: "ChargeItem", status: "billable", subject: { reference: "Patient/synthetic" },
    code: { coding: [{ system: "urn:synthetic:billing", code, display: code === "PHOTO1" ? "Synthetic photograph" : "Synthetic visit" }] },
    quantity: { value: 1 }, priceOverride: { value: 30, currency: "USD" }, diagnosisSequence: [2],
  });
  const input: ServerClaimInput = {
    created: "2026-09-23", serviceDate: "2026-09-23", patientReference: "Patient/synthetic",
    providerReference: "Practitioner/synthetic", insurerReference: "Organization/payer", coverageReference: "Coverage/synthetic",
    patientAccountNumber: "SYNTHETICCLAIM", payerId: "SYNTHETICPAYER",
    billingProvider: { name: "Synthetic clinic", npi: "1111111112", taxId: "900000001", taxIdType: "E", address1: "1 Synthetic St", city: "Test", state: "NY", zip: "10001", phone: "5555550100" },
    renderingProvider: { firstName: "Test", lastName: "Provider", npi: "1111111112" },
    subscriber: { firstName: "Test", lastName: "Patient", memberId: "SYNTHETIC", dateOfBirth: "1980-01-01", sex: "F", relationshipCode: "18", address1: "2 Synthetic St", city: "Test", state: "NY", zip: "10001" },
    patient: { firstName: "Test", lastName: "Patient", dateOfBirth: "1980-01-01", sex: "F" },
    diagnoses: [{ system: "urn:synthetic:diagnosis", code: "DX1" }, { system: "urn:synthetic:diagnosis", code: "DX2" }],
    chargeItems: [charge("PHOTO1"), charge("VISIT1")],
  };
  const adapter = {
    id: clearinghouse, mode: "test", submitterId: "SYNTHETIC",
    async submitProfessionalClaim(payload: unknown) {
      payloads.push(structuredClone(payload));
      return clearinghouse === "claimmd"
        ? { claims: [{ claimMdClaimId: "synthetic-md", claimMdId: "synthetic-tracking", status: "A" }] }
        : { claimReference: { correlationId: "synthetic-stedi", customerClaimNumber: "synthetic-tracking" } };
    },
  } as unknown as ClearinghouseAdapter;
  const fhir = {
    baseUrl: "http://localhost:18103/",
    async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
      const row = stored.find(resource => resource.resourceType === type && resource.id === id);
      if (!row) throw Object.assign(new Error("Missing synthetic resource"), { status: 404 });
      return structuredClone(row) as T;
    },
    async search<T extends Resource>(type: T["resourceType"]): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: stored.filter(row => row.resourceType === type).map(resource => ({ resource: structuredClone(resource) as T })) };
    },
    async create<T extends Resource>(resource: T): Promise<T> {
      const saved = { ...structuredClone(resource), id: `${resource.resourceType.toLowerCase()}-${writes.length + 1}` };
      writes.push(saved);
      return saved;
    },
    async update<T extends Resource>(_type: T["resourceType"], _id: string, resource: T): Promise<T> { writes.push(resource); return resource; },
  };
  const deps: ClaimsHandlerDeps = {
    authenticate: async () => ({ staffReference: "Practitioner/synthetic-staff", actorRole: "staff", businessActions: ["claims.manage"], fhir }),
    adapter: null, adapters: { [clearinghouse]: adapter }, recordAudit: async row => { audits.push(row); }, now: () => "2026-09-23T12:00:00Z",
  };
  return { input, deps, writes, payloads, audits, stored, charge, run: () => handleSubmitClaimRequest(deps, { authHeader: "synthetic", body: { claim: input, clearinghouse } }) };
}

for (const adapter of ["claimmd", "stedi"] as const) {
  test(`H5 ${adapter}: hand-typed imaging line is held before persistence and submission`, async () => {
    const fixture = holdSubmitFixture(adapter);
    const result = await fixture.run();
    assert.equal(result.status, 200);
    const body = result.body as { heldLines?: Array<{ index: number; message: string }> };
    assert.deepEqual(body.heldLines?.map(line => line.index), [0]);
    assert.equal(body.heldLines?.[0]?.message, "Synthetic photograph was held: it needs an interpretation and report on this visit.");
    const charges = fixture.writes.filter((row): row is ChargeItem => row.resourceType === "ChargeItem");
    assert.equal(charges.length, 1);
    assert.equal(charges[0].code.coding?.[0]?.code, "VISIT1");
    const sent = JSON.stringify(fixture.payloads);
    assert.doesNotMatch(sent, /PHOTO1/);
    assert.match(sent, /VISIT1/);
    const savedClaim = fixture.writes.find(row => row.resourceType === "Claim");
    assert.deepEqual(savedClaim?.resourceType === "Claim" && savedClaim.item?.[0]?.diagnosisSequence, [2]);
    assert.equal(fixture.audits.length, 1);
    assert.equal(fixture.audits[0].eventType, "claim.submit.completed");
    assert.match(fixture.audits[0].actionReason ?? "", /Synthetic photograph/);
  });

  test(`H6 ${adapter}: all-held claim returns 409 with zero resource writes or adapter calls`, async () => {
    const fixture = holdSubmitFixture(adapter);
    fixture.input.chargeItems = [fixture.charge("PHOTO1")];
    const result = await fixture.run();
    assert.equal(result.status, 409);
    assert.equal((result.body as { code: string }).code, "all-lines-held");
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.payloads.length, 0);
    assert.equal(fixture.audits.length, 1);
    assert.equal(fixture.audits[0].eventType, "claim.submit.failed");
    assert.match(fixture.audits[0].actionReason ?? "", /all-lines-held: 1 lines/);
  });

  test(`H7 ${adapter}: unknown hand-typed code remains ungated`, async () => {
    const fixture = holdSubmitFixture(adapter);
    fixture.input.chargeItems = [fixture.charge("UNKNOWN1")];
    const result = await fixture.run();
    assert.equal(result.status, 200);
    assert.equal(Object.hasOwn(result.body as object, "heldLines"), false);
    assert.equal(fixture.writes.filter(row => row.resourceType === "ChargeItem").length, 1);
    assert.match(JSON.stringify(fixture.payloads), /UNKNOWN1/);
  });

  test(`H10 ${adapter}: no-hold result matches pinned base bytes`, async () => {
    const fixture = holdSubmitFixture(adapter);
    fixture.input.chargeItems = [fixture.charge("VISIT1")];
    const result = await fixture.run();
    assert.equal(result.status, 200);
    assert.equal(Object.hasOwn(result.body as object, "heldLines"), false);
    const actual = JSON.stringify({ result, writes: fixture.writes, payloads: fixture.payloads });
    if (process.env.CLAIM_HOLD_BASE_CAPTURE) writeFileSync(`${process.env.CLAIM_HOLD_BASE_CAPTURE}/${adapter}.json`, actual);
    if (process.env.CLAIM_HOLD_BASE_COMPARE) assert.equal(actual, readFileSync(`${process.env.CLAIM_HOLD_BASE_COMPARE}/${adapter}.json`, "utf8"));
  });
}

test("stored imaging classification uses the server ChargeItem, not the submitted code", async () => {
  const fixture = holdSubmitFixture();
  fixture.stored.push({ ...fixture.charge("PHOTO1"), id: "stored-image" });
  fixture.input.chargeItems = [{ ...fixture.charge("VISIT1"), id: "stored-image" }];
  const result = await fixture.run();
  assert.equal(result.status, 409);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.payloads.length, 0);
});
