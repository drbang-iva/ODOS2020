import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Bundle, Extension, Person, RelatedPerson, Resource, Task } from "@medplum/fhirtypes";

const PROJECT = "g2b1-synthetic";
const SERVICE = "ClientApplication/g2b1-service";
const CODE = "https://odos2020.com/fhir/CodeSystem/guarantor-link-operation";
const CLAIM = "https://odos2020.com/fhir/StructureDefinition/guarantor-link-claim";
const staff = { staffReference: "Practitioner/g2b1-staff", actorRole: "staff", roles: ["staff"], businessActions: ["guarantor.link"], project: { reference: `Project/${PROJECT}` } };
type Write = { resource: Resource; expected?: string; status?: number; actor: unknown; method?: string };

export function fixture(count = 2) {
  const data = new Map<string, Resource>();
  const writes: Write[] = [];
  const audits: any[] = [];
  let beforeWrite: ((write: Write) => Promise<void>) | undefined;
  let afterWrite: ((write: Write) => Promise<void>) | undefined;
  let afterRead: ((resource: Resource) => Promise<void>) | undefined;
  let beforeSearch: ((type: string, params: Record<string, string>) => Promise<void>) | undefined;
  function seed<T extends Resource>(resource: T): T {
    const saved = { ...structuredClone(resource), meta: { versionId: "1", project: PROJECT, author: { reference: SERVICE }, ...resource.meta } };
    data.set(`${resource.resourceType}/${resource.id}`, saved);
    return structuredClone(saved);
  }
  function get<T extends Resource>(ref: string): T { const r = data.get(ref); if (!r) throw Object.assign(new Error("FHIR 404"), { status: 404 }); return structuredClone(r) as T; }
  function compete(ref: string, change: (r: any) => Resource, writer = "Practitioner/competitor") { const prior = get(ref); const next = change(prior); data.set(ref, { ...next, meta: { ...next.meta, versionId: String(Number(prior.meta!.versionId) + 1), author: { reference: writer } } }); }
  const ids = Array.from({ length: count }, (_, i) => `r${i + 1}`);
  const S = seed<Person>({ resourceType: "Person", id: "S", active: true, name: [{ family: "Source" }], link: ids.map(id => ({ target: { reference: `RelatedPerson/${id}` }, assurance: "level2" })) });
  const D = seed<Person>({ resourceType: "Person", id: "D", active: true, name: [{ family: "Destination" }], telecom: [{ system: "phone", value: "864-555-0199", extension: [{ url: "urn:synthetic:phone-flag", valueBoolean: true }] }], address: [{ city: "Synthetic Town" }], link: [{ target: { reference: "RelatedPerson/k" }, assurance: "level2" }] });
  for (const [index, id] of [...ids, "k"].entries()) {
    seed({ resourceType: "Patient", id: `p-${id}`, name: [{ family: `Synthetic ${id}` }] });
    seed<RelatedPerson>({ resourceType: "RelatedPerson", id, patient: { reference: `Patient/p-${id}` }, active: index % 2 === 0,
      name: [{ family: id === "k" ? "Sibling" : "Source" }], relationship: [{ text: "Guardian" }], period: { start: "2026-01-01", end: "2027-01-01" },
      telecom: [{ system: "phone", value: "864-555-0100", extension: [{ url: "urn:synthetic:old-phone-flag", valueBoolean: false }] }],
      extension: ["consent-authority", "primary", "court-order", "no-textable", "unrelated"].map(tag => ({ url: `urn:synthetic:${tag}`, valueString: `${id}-${tag}` })) });
  }
  const fhir = {
    baseUrl: "http://g2b1-synthetic.test",
    async readExtended(type: string, id: string) { const r = get(`${type}/${id}`); await afterRead?.(r); return r; },
    async searchProject(type: string, project: string, params: Record<string, string> = {}) {
      await beforeSearch?.(type, params);
      const rows = [...data.values()].filter((r: any) => r.resourceType === type && r.meta?.project === project
        && (!params.link || r.link?.some((l: any) => l.target.reference === params.link))
        && (!params["based-on"] || r.basedOn?.some((l: any) => l.reference === params["based-on"]))
        && (!params.code || r.code?.coding?.some((c: any) => params.code === `${c.system}|` || params.code === `${c.system}|${c.code}`))
        && (!params.identifier || r.identifier?.some((i: any) => params.identifier === `${i.system}|${i.value}`)));
      return { resourceType: "Bundle", type: "searchset", entry: rows.map(resource => ({ resource: structuredClone(resource) })) };
    },
    async executeTransactionAsActor(bundle: Bundle, actor: unknown, _headers: unknown, options: any) {
      assert.equal(bundle.entry?.length, 1, "every operation write is single-entry");
      assert.equal(options.autoRollbackCreatedEntries, false);
      assert.equal(typeof options.validateResponse, "function");
      const entry = bundle.entry![0];
      const resource = structuredClone(entry.resource!);
      const write: Write = { resource, expected: entry.request?.ifMatch?.replace(/^W\/"|"$/g, ""), actor, method: entry.request?.method };
      writes.push(write);
      await beforeWrite?.(write);
      let actual: Resource | undefined;
      let status = entry.request?.method === "POST" ? 201 : 200;
      if (entry.request?.method === "POST") {
        const existing = [...data.values()].find((r: any) => r.resourceType === "Task" && r.identifier?.some((i: any) => (resource as Task).identifier?.some(j => i.system === j.system && i.value === j.value)));
        if (entry.request.ifNoneExist && existing) { actual = existing; status = 200; }
        else { resource.id = randomUUID(); actual = seed(resource); }
      } else {
        const prior = data.get(`${resource.resourceType}/${resource.id}`);
        if (prior?.meta?.versionId !== write.expected) status = 412;
        else if (entry.request?.method === "DELETE") data.delete(`${resource.resourceType}/${resource.id}`);
        else {
          actual = { ...resource, meta: { ...resource.meta, versionId: String(Number(prior.meta!.versionId) + 1), author: { reference: SERVICE } } };
          data.set(`${resource.resourceType}/${resource.id}`, actual);
        }
      }
      write.status = status;
      const response: Bundle = { resourceType: "Bundle", type: "transaction-response", entry: [{ ...(actual ? { resource: structuredClone(actual) } : {}), response: { status: String(status), ...(actual ? { location: `${actual.resourceType}/${actual.id}/_history/${actual.meta!.versionId}` } : {}) } }] };
      await afterWrite?.(write);
      options.validateResponse(response);
      return response;
    },
  };
  const deps = { serviceFhir: fhir, serviceReference: SERVICE, recordAudit: async (row: any) => { audits.push(row); }, now: () => "2026-09-14T12:00:00.000Z" };
  function input(kind = "transfer", selected = ids) { return { operationId: randomUUID(), kind, sourcePersonId: "S", destinationPersonId: "D", relatedPersonIds: selected, expected: Object.fromEntries(["Person/S", "Person/D", ...selected.map(id => `RelatedPerson/${id}`)].map(ref => [ref, get(ref).meta!.versionId])), reason: "Synthetic staff-approved transfer" }; }
  function owners(id: string) { return [...data.values()].filter((r: any) => r.resourceType === "Person" && r.link?.some((l: any) => l.target.reference === `RelatedPerson/${id}`)).map(r => r.id).sort(); }
  return { deps, input, data, seed, get, compete, owners, writes, audits, ids, S, D,
    set beforeWrite(hook: typeof beforeWrite) { beforeWrite = hook; }, set afterWrite(hook: typeof afterWrite) { afterWrite = hook; }, set afterRead(hook: typeof afterRead) { afterRead = hook; }, set beforeSearch(hook: typeof beforeSearch) { beforeSearch = hook; } };
}

export async function run(f: ReturnType<typeof fixture>, action: string, body?: unknown, taskId?: string) {
  const api = await import("../src/clinic/guarantor-link-operation.js");
  return api.handleGuarantorOperation(f.deps, staff, { action, body, taskId });
}

