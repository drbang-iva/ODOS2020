import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, RelatedPerson, Resource } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import { handlePatientInsuranceWrite, handleVisionBenefitsWrite, type PatientInsuranceHandlerDeps } from "../src/insurance/patient-insurance-handlers.js";
import { CONSENT_AUTHORITY_EXTENSION_URL, RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL } from "../src/clinic/patient-registration-endpoint.js";

const conflict = "This record changed while you were editing it. Reload and try again.";
const guardianError = "This person is a responsible party. Save the subscriber as a separate record.";
function coverage(method: "POST" | "PUT" = "PUT"): Bundle {
  return { resourceType: "Bundle", type: "transaction", entry: [
    { fullUrl: method === "POST" ? "urn:uuid:subscriber" : undefined, resource: { resourceType: "RelatedPerson", id: method === "PUT" ? "subscriber" : undefined, patient: { reference: "Patient/patient" } }, request: { method, url: method === "PUT" ? "RelatedPerson/subscriber" : "RelatedPerson", ifMatch: method === "PUT" ? 'W/"1"' : undefined } },
    { resource: { resourceType: "Coverage", status: "active", beneficiary: { reference: "Patient/patient" }, subscriber: { reference: method === "POST" ? "urn:uuid:subscriber" : "RelatedPerson/subscriber" }, payor: [{ reference: "Organization/payer" }] }, request: { method: "POST", url: "Coverage" } },
  ] };
}
function fixture(statuses: Record<string, string> = {}, extensions: RelatedPerson["extension"] = [], linked = false) {
  const requests: Bundle[] = [];
  const reads: string[] = [];
  const audits: OdosAuditEventRecord[] = [];
  const rollbackOptions: unknown[] = [];
  const deps: PatientInsuranceHandlerDeps = {
    authenticate: async () => ({ staffReference: "Practitioner/staff", actorRole: "staff", roles: ["staff"], fhir: {
      baseUrl: "http://127.0.0.1:19813",
      search: async <T extends Resource>(type: string, params?: Record<string, string>): Promise<Bundle<T>> => {
        reads.push(`${type}?${new URLSearchParams(params)}`);
        const resources = type === "RelatedPerson" ? [{ resourceType: "RelatedPerson", id: "subscriber", patient: { reference: "Patient/patient" }, extension: extensions }] : linked ? [{ resourceType: "Person", id: "guardian" }] : [];
        return { resourceType: "Bundle", type: "searchset", entry: resources.map(resource => ({ resource: resource as T })) };
      },
      searchUrl: async () => { throw new Error("Unexpected pagination"); },
      executeTransaction: async (bundle, _headers, options) => {
        requests.push(structuredClone(bundle));
        rollbackOptions.push(options?.autoRollbackCreatedEntries);
        return { resourceType: "Bundle", type: "transaction-response", entry: bundle.entry?.map(entry => ({ response: { status: statuses[entry.resource!.resourceType] ?? "201 Created", location: `${entry.resource!.resourceType}/saved/_history/2` } })) };
      },
    } }),
    recordAudit: async row => { audits.push(row); },
  };
  const save = (bundle = coverage()) => handlePatientInsuranceWrite(deps, { authHeader: "Bearer staff", body: { bundle } });
  return { deps, requests, reads, audits, rollbackOptions, save };
}
function writes(f: ReturnType<typeof fixture>) { assert.ok(f.rollbackOptions.every(value => value === false), "Insurance must disable compensating deletes"); return f.requests.map(b => b.entry!.map(e => e.request!.url)); }
function denied(f: ReturnType<typeof fixture>) { assert.deepEqual(f.audits.map(a => a.actionOutcome), ["denied"]); }

test("I1 stale subscriber stops before Coverage", async () => {
  const f = fixture({ RelatedPerson: "412 Precondition Failed" });
  const result = await f.save();
  assert.deepEqual(writes(f), [["RelatedPerson/subscriber"]]);
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: conflict, written: [] });
  denied(f); assert.match(f.audits[0].actionReason!, /RelatedPerson\/subscriber.*412/);
});
test("I2 mixed create response reports surviving subscriber and denied audit", async () => {
  const f = fixture({ Coverage: "400 Bad Request" }); const result = await f.save(coverage("POST"));
  assert.equal(result.status, 502); assert.deepEqual((result.body as any).written, ["RelatedPerson/saved/_history/2"]);
  assert.deepEqual(writes(f), [["RelatedPerson", "Coverage"]]); denied(f);
  assert.match(f.audits[0].actionReason!, /Coverage.*400/); assert.match(f.audits[0].actionReason!, /RelatedPerson\/saved\/_history\/2/);
});
test("I3 unversioned subscriber PUT submits nothing", async () => {
  const f = fixture(); const bundle = coverage(); delete bundle.entry![0].request!.ifMatch;
  assert.deepEqual(await f.save(bundle), { status: 400, body: { error: "Subscriber updates require a version." } });
  assert.deepEqual(writes(f), []); assert.deepEqual(f.reads, []); assert.ok(f.audits.every(a => a.actionOutcome !== "granted"));
});
for (const [name, extensions, linked] of [
  ["I4 primary extension alone fences guardian", [{ url: RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL, valueBoolean: false }], false],
  ["I5 Person link alone fences guardian", [], true],
  ["I6 current server extensions cannot be omitted by request body", [{ url: CONSENT_AUTHORITY_EXTENSION_URL, valueBoolean: true }], false],
] as const) test(name, async () => {
  const f = fixture({}, [...extensions], linked); const result = await f.save();
  assert.deepEqual(result, { status: 422, body: { error: guardianError } }); assert.deepEqual(writes(f), []); denied(f);
  assert.ok(f.reads.some(read => read.startsWith("RelatedPerson?") && new URLSearchParams(read.split("?")[1]).get("_id") === "subscriber"));
  if (linked) assert.ok(f.reads.some(read => read.startsWith("Person?") && new URLSearchParams(read.split("?")[1]).get("link") === "RelatedPerson/subscriber"));
});
test("I7 Coverage-only existing guardian reference is fenced", async () => {
  const f = fixture({}, [], true); const bundle = coverage(); bundle.entry!.shift();
  assert.deepEqual(await f.save(bundle), { status: 422, body: { error: guardianError } });
  assert.deepEqual(writes(f), []); denied(f);
});
test("I8 versioned subscriber-only update succeeds before Coverage", async () => {
  const f = fixture(); const result = await f.save(); assert.equal(result.status, 200);
  assert.equal((result.body as Bundle).entry?.length, 2);
  assert.deepEqual(writes(f), [["RelatedPerson/subscriber"], ["Coverage"]]);
  assert.deepEqual(f.audits.map(a => a.actionOutcome), ["granted"]);
});
test("I9 mixed vision benefits response is denied with written locations", async () => {
  const f = fixture({ CoverageEligibilityResponse: "422 Unprocessable Entity" });
  const bundle: Bundle = { resourceType: "Bundle", type: "transaction", entry: [
    { fullUrl: "urn:uuid:request", resource: { resourceType: "CoverageEligibilityRequest", status: "active", purpose: ["benefits"], patient: { reference: "Patient/patient" }, created: "2026-09-13", insurer: { reference: "Organization/payer" }, insurance: [{ coverage: { reference: "Coverage/plan" } }] }, request: { method: "POST", url: "CoverageEligibilityRequest" } },
    { resource: { resourceType: "CoverageEligibilityResponse", status: "active", purpose: ["benefits"], patient: { reference: "Patient/patient" }, created: "2026-09-13", insurer: { reference: "Organization/payer" }, request: { reference: "urn:uuid:request" }, outcome: "complete", insurance: [{ coverage: { reference: "Coverage/plan" } }] }, request: { method: "POST", url: "CoverageEligibilityResponse" } },
  ] };
  const result = await handleVisionBenefitsWrite(f.deps, { authHeader: "Bearer staff", body: { bundle } });
  assert.equal(result.status, 502); assert.deepEqual((result.body as any).written, ["CoverageEligibilityRequest/saved/_history/2"]);
  assert.deepEqual(writes(f), [["CoverageEligibilityRequest", "CoverageEligibilityResponse"]]); denied(f);
  assert.match(f.audits[0].actionReason!, /CoverageEligibilityResponse.*422/);
});

test("Insurance entry URLs cannot disguise a guardian write as Coverage", async () => {
  const f = fixture(); const bundle = coverage("POST"); bundle.entry![1].request!.url = "RelatedPerson/guardian";
  assert.equal((await f.save(bundle)).status, 400); assert.deepEqual(writes(f), []);
});
test("Subscriber PUT target must match its resource id", async () => {
  const f = fixture(); const bundle = coverage(); bundle.entry![0].request!.url = "RelatedPerson/other";
  assert.equal((await f.save(bundle)).status, 400); assert.deepEqual(writes(f), []);
});
test("Noncanonical subscriber references cannot bypass the guardian fence", async () => {
  for (const reference of ["http://127.0.0.1:19813/fhir/R4/RelatedPerson/guardian", "RelatedPerson/guardian/_history/1", "RelatedPerson/guardian?x=1"]) {
    const f = fixture(); const bundle = coverage(); bundle.entry!.shift();
    (bundle.entry![0].resource as any).subscriber.reference = reference;
    assert.equal((await f.save(bundle)).status, 400, reference); assert.deepEqual(writes(f), []);
  }
});
test("A later Coverage failure reports the earlier successful subscriber PUT", async () => {
  const f = fixture({ Coverage: "412 Precondition Failed" }); const result = await f.save();
  assert.equal(result.status, 409); assert.deepEqual((result.body as any).written, ["RelatedPerson/saved/_history/2"]);
  assert.deepEqual(writes(f), [["RelatedPerson/subscriber"], ["Coverage"]]); denied(f);
  assert.match(f.audits[0].actionReason!, /RelatedPerson\/saved\/_history\/2/);
});
