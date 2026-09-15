import { buildAgeOfMajorityConfigResource } from "../../src/clinic/age-of-majority-config.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Bundle, Person, RelatedPerson, Resource, Task } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../../src/authz/odosAudit.js";
import { CONSENT_AUTHORITY_EXTENSION_URL, RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL } from "../../src/clinic/patient-registration-endpoint.js";
import { ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, ODOS_TEXTABLE_NUMBER_EXTENSION_URL } from "../../src/clinic/patient-telecom.js";

const project = "guarantor-reader-proof";
const service = "ClientApplication/guarantor-reader-service";
const staff = { staffReference: "Practitioner/reader-staff", actorRole: "staff" as const, roles: ["staff"] as const, businessActions: ["guarantor.link"] as const, project: { reference: `Project/${project}` } };
export const readerDate = "2026-09-14T12:00:00.000Z";
export const sourceDetails = { name: [{ given: ["Source"], family: "Guardian" }], telecom: [{ system: "phone" as const, value: "+15555550101", extension: [{ url: ODOS_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: false }] }], address: [{ line: ["1 Source Street"], city: "Synthetic Town" }] };
export const destinationDetails = { name: [{ given: ["Destination"], family: "Guardian" }], telecom: [{ system: "phone" as const, value: "+15555550199", extension: [{ url: ODOS_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }] }], address: [{ line: ["2 Destination Street"], city: "Synthetic Town" }] };

export function guarantorReaderFixture() {
  const records = new Map<string, Resource>();
  put(JSON.parse(JSON.stringify({ ...buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 18 }), id: "majority-config" })));
  const writes: { lane: "operation" | "reader"; method: string; resource: Resource; status: number }[] = [];
  const reads: { type: string; params: Record<string, string>; ids: string[] }[] = [];
  const audits: OdosAuditEventRecord[] = [];
  function put<T extends Resource>(resource: T): T {
    const saved = { ...structuredClone(resource), meta: { project, versionId: "1", author: { reference: service }, ...resource.meta } };
    records.set(`${saved.resourceType}/${saved.id}`, saved);
    return structuredClone(saved);
  }
  function get<T extends Resource>(reference: string): T {
    const resource = records.get(reference);
    if (!resource) throw Object.assign(new Error(`FHIR 404: ${reference}`), { status: 404 });
    return structuredClone(resource) as T;
  }
  for (const [id, given] of [["sam", "Sam"], ["leo", "Leo"], ["existing", "Existing"]]) put({ resourceType: "Patient", id, birthDate: "2015-01-01", name: [{ given: [given], family: "Synthetic" }], address: [{ line: [`${id} Patient Street`] }] });
  put<Person>({ resourceType: "Person", id: "S", active: true, ...sourceDetails, link: ["r1", "r2"].map(id => ({ target: { reference: `RelatedPerson/${id}` }, assurance: "level2" })) });
  put<Person>({ resourceType: "Person", id: "D", active: true, ...destinationDetails, link: [{ target: { reference: "RelatedPerson/k" }, assurance: "level2" }] });
  for (const [id, patientId, active, authority, primary] of [
    ["r1", "sam", true, true, true], ["r2", "leo", false, false, false],
    ["k", "existing", true, false, false], ["secondary", "sam", true, true, false],
    ["no-consent", "sam", true, false, false], ["inactive", "sam", false, true, false],
  ] as const) put<RelatedPerson>({ resourceType: "RelatedPerson", id, patient: { reference: `Patient/${patientId}` }, active,
    ...(id === "r1" || id === "r2" ? sourceDetails : { name: [{ given: [id], family: "Other Guardian" }], address: [{ line: [`${id} Other Street`] }] }),
    relationship: [{ text: `Relationship ${id}` }], period: { start: "2026-01-01", end: "2027-01-01" },
    extension: [
      { url: CONSENT_AUTHORITY_EXTENSION_URL, valueBoolean: authority },
      { url: RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL, valueBoolean: primary },
      { url: "https://odos2020.com/fhir/StructureDefinition/related-person-court-order-notes", valueString: `Court order ${id}` },
      ...(id === "r1" ? [{ url: ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }] : []),
      { url: "urn:synthetic:unrelated", valueString: `Preserve ${id}` },
    ],
  });
  put({ resourceType: "Account", id: "sam-account", status: "active", subject: [{ reference: "Patient/sam" }], guarantor: ["secondary", "r1"].map(id => ({ party: { reference: `RelatedPerson/${id}` }, onHold: false })) });
  put({ resourceType: "Invoice", id: "sam-invoice", status: "issued", subject: { reference: "Patient/sam" }, date: "2026-09-14T09:00:00.000Z",
    lineItem: [{ sequence: 1, priceComponent: [{ type: "base", amount: { value: 100, currency: "USD" } }] }], totalGross: { value: 100, currency: "USD" }, totalNet: { value: 100, currency: "USD" } });

  function search<T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Bundle<T> {
    const rows = [...records.values()].filter(resource => {
      if (resource.resourceType !== type) return false;
      const r = resource as Resource & { active?: boolean; status?: string; patient?: { reference?: string }; subject?: { reference?: string } | { reference?: string }[]; code?: { coding?: { system?: string; code?: string }[] }; identifier?: { system?: string; value?: string }[] };
      return Object.entries(params).every(([key, value]) => {
        switch (key) {
          case "_count": case "_sort": return true;
          case "_id": return value.split(",").includes(r.id!);
          case "active": return String(r.active) === value;
          case "status": return r.status === value;
          case "subject": return !Array.isArray(r.subject) && r.subject?.reference === value;
          case "patient": return value.split(",").some(v => (r.resourceType === "Account" ? (r.subject as { reference?: string }[])?.some(s => s.reference?.replace(/^Patient\//, "") === v.replace(/^Patient\//, "")) : r.patient?.reference?.replace(/^Patient\//, "") === v.replace(/^Patient\//, "")));
          case "link": return r.resourceType === "Person" && r.link?.some(link => link.target.reference === value);
          case "based-on": return r.resourceType === "Task" && r.basedOn?.some(link => link.reference === value);
          case "code": return r.code?.coding?.some(c => value === `${c.system}|` || value === `${c.system}|${c.code}`);
          case "identifier": return r.identifier?.some(i => value === `${i.system}|${i.value}`);
          default: throw new Error(`Unsupported fixture search ${type}?${key}`);
        }
      });
    });
    reads.push({ type, params: structuredClone(params), ids: rows.map(r => r.id!) });
    return { resourceType: "Bundle", type: "searchset", entry: rows.map(resource => ({ resource: structuredClone(resource) as T })) };
  }
  async function transaction(bundle: Bundle, lane: "operation" | "reader"): Promise<Bundle> {
    const entries: NonNullable<Bundle["entry"]> = [];
    for (const entry of bundle.entry ?? []) {
      assert.ok(entry.resource && entry.request);
      const resource = structuredClone(entry.resource);
      const method = entry.request.method;
      assert.ok(method === "POST" || method === "PUT");
      let status = method === "POST" ? 201 : 200;
      if (method === "POST") resource.id ??= randomUUID();
      const reference = `${resource.resourceType}/${resource.id}`;
      const current = records.get(reference);
      if (entry.request.ifMatch && entry.request.ifMatch !== `W/"${current?.meta?.versionId}"`) status = 412;
      if (status < 400) put({ ...resource, meta: { ...resource.meta, versionId: String(Number(current?.meta?.versionId ?? 0) + 1), author: { reference: lane === "operation" ? service : staff.staffReference } } } as Resource);
      const saved = status < 400 ? get(reference) : resource;
      writes.push({ lane, method, resource: structuredClone(saved), status });
      entries.push({ ...(status < 400 ? { resource: saved } : {}), response: { status: String(status), ...(status < 400 ? { location: `${reference}/_history/${saved.meta!.versionId}` } : {}) } });
    }
    return { resourceType: "Bundle", type: "transaction-response", entry: entries };
  }
  const fhir = {
    baseUrl: "http://guarantor-reader-proof.test",
    async search<T extends Resource>(type: T["resourceType"], params?: Record<string, string>) { return search<T>(type, params); },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> { throw new Error("Unexpected fixture pagination"); },
    async read<T extends Resource>(type: T["resourceType"], id: string) { return get<T>(`${type}/${id}`); },
    async readExtended<T extends Resource>(type: T["resourceType"], id: string) { return get<T>(`${type}/${id}`); },
    async searchProject<T extends Resource>(type: T["resourceType"], requestedProject: string, params?: Record<string, string>) { assert.equal(requestedProject, project); return search<T>(type, params); },
    async searchProjectUrl<T extends Resource>(): Promise<Bundle<T>> { throw new Error("Unexpected fixture pagination"); },
    executeTransaction: (bundle: Bundle) => transaction(bundle, "reader"),
    async executeTransactionAsActor(bundle: Bundle, actor: { actorReference: string }, _headers: unknown, options: { autoRollbackCreatedEntries?: boolean; validateResponse?: (bundle: Bundle) => void }) {
      assert.equal(bundle.entry?.length, 1); assert.equal(actor.actorReference, staff.staffReference); assert.equal(options.autoRollbackCreatedEntries, false);
      const response = await transaction(bundle, "operation"); options.validateResponse?.(response); return response;
    },
  };
  async function transfer() {
    const { handleGuarantorOperation } = await import("../../src/clinic/guarantor-link-operation.js");
    const result = await handleGuarantorOperation({ serviceFhir: fhir, serviceReference: service, now: () => readerDate, recordAudit: async row => { audits.push(row); } }, staff, { action: "create", body: {
      operationId: randomUUID(), kind: "transfer", sourcePersonId: "S", destinationPersonId: "D", relatedPersonIds: ["r1", "r2"],
      expected: Object.fromEntries(["Person/S", "Person/D", "RelatedPerson/r1", "RelatedPerson/r2"].map(reference => [reference, get(reference).meta!.versionId])), reason: "Synthetic guardian transfer reader proof",
    } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((result.body as { task: Task }).task.status, "completed");
    for (const id of ["r1", "r2"]) assert.deepEqual((await fhir.search<Person>("Person", { link: `RelatedPerson/${id}` })).entry?.map(e => e.resource?.id), ["D"]);
    return result;
  }
  return { records, writes, reads, audits, put, get, fhir, staff, transfer };
}
