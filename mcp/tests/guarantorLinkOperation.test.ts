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

function fixture(count = 2) {
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

async function run(f: ReturnType<typeof fixture>, action: string, body?: unknown, taskId?: string) {
  const api = await import("../src/clinic/guarantor-link-operation.js");
  return api.handleGuarantorOperation(f.deps, staff, { action, body, taskId });
}

test("L6/L7/L8: consolidate retains S, D wins, moved child fields and write set are fenced", async () => {
  const f = fixture(); const before = f.ids.map(id => f.get<RelatedPerson>(`RelatedPerson/${id}`));
  const result = await run(f, "create", f.input("consolidate"));
  assert.equal(result.status, 200); assert.equal(result.body.task.status, "completed");
  assert.equal(f.get<Person>("Person/S").active, false); assert.equal(f.get<Person>("Person/S").link?.length ?? 0, 0);
  for (const [i, id] of f.ids.entries()) {
    const r = f.get<RelatedPerson>(`RelatedPerson/${id}`);
    assert.deepEqual(f.owners(id), ["D"]); assert.deepEqual(r.name, f.D.name); assert.deepEqual(r.telecom, f.D.telecom);
    for (const field of ["active", "patient", "period", "relationship", "extension"] as const) assert.deepEqual(r[field], before[i][field], `${id} preserves ${field}`);
    for (const write of f.writes.filter(w => w.status === 200 && w.resource.resourceType === "RelatedPerson" && w.resource.id === id)) {
      const attempted = write.resource as RelatedPerson;
      for (const field of ["active", "patient", "period", "relationship"] as const) assert.deepEqual(attempted[field], before[i][field], `${id} preserves ${field} on every write`);
      assert.deepEqual(attempted.extension?.filter(e => e.url !== CLAIM), before[i].extension);
    }
  }
  assert.ok(f.writes.every(w => w.resource.resourceType === "Task" || ["Person/S", "Person/D", ...f.ids.map(id => `RelatedPerson/${id}`)].includes(`${w.resource.resourceType}/${w.resource.id}`)));
  assert.equal(f.writes.filter(w => w.resource.id === "k").length, 0);
  assert.equal(f.audits.filter(r => r.eventType === "guarantor.link.started").length, 2);
  assert.equal(f.audits.filter(r => r.eventType === "guarantor.link.completed").length, 2);
});

test("L9: stale confirmation refuses before any Task or resource write", async () => {
  const f = fixture(); const body = f.input(); f.compete("Person/D", p => ({ ...p, name: [{ family: "New" }] }));
  const result = await run(f, "create", body); assert.equal(result.status, 409); assert.equal(f.writes.length, 0);
});
test("L10: consolidate subset refuses before any write", async () => {
  const f = fixture(); const result = await run(f, "create", f.input("consolidate", ["r1"]));
  assert.equal(result.status, 422); assert.equal(f.writes.length, 0);
});
test("L11: foreign D and separately foreign child Patient refuse without writes", async () => {
  for (const ref of ["Person/D", "Patient/p-r1"]) { const f = fixture(); f.compete(ref, r => ({ ...r, meta: { ...r.meta, project: "foreign-project" } }));
    const result = await run(f, "create", f.input()); assert.equal(result.status, 422); assert.equal(f.writes.length, 0); }
});
test("L21: repeated operation identifier returns one Task and performs no second writes", async () => {
  const f = fixture(); const input = f.input(); const first = await run(f, "create", input); const count = f.writes.length;
  const second = await run(f, "create", input); assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(first.body.task.id, second.body.task.id); assert.equal(f.writes.length, count);
});

async function attachPending(f: ReturnType<typeof fixture>, selected = f.ids) {
  let once = true;
  f.beforeWrite = async w => { if (once && w.resource.resourceType === "Person" && w.resource.id === "D") { once = false; f.compete("Person/D", p => ({ ...p, name: [{ family: "Changed destination" }] })); } };
  const result = await run(f, "create", f.input("transfer", selected)); f.beforeWrite = undefined;
  assert.equal(result.status, 409); assert.equal(result.body.phase, "attach-pending");
  return result.body.task as Task;
}
test("L3: detach-first leaves an unowned claimed child and Complete projects current D", async () => {
  const f = fixture(); const task = await attachPending(f);
  for (const id of f.ids) { assert.deepEqual(f.owners(id), []); assert.equal(f.get<RelatedPerson>(`RelatedPerson/${id}`).extension?.find(e => e.url === CLAIM)?.valueReference?.reference, `Task/${task.id}`); }
  const result = await run(f, "complete", undefined, task.id);
  assert.equal(result.status, 200); assert.equal(result.body.task.status, "completed");
  for (const id of f.ids) { assert.deepEqual(f.owners(id), ["D"]); assert.deepEqual(f.get<RelatedPerson>(`RelatedPerson/${id}`).name, [{ family: "Changed destination" }]); }
});
test("L24 step 0: foreign-code based-on lab Tasks and foreign-author operations are excluded", async () => {
  const f = fixture(); const original = await attachPending(f);
  for (const status of ["in-progress", "completed"] as const) f.seed<Task>({ ...original, id: `lab-${status}`, status, code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/task-type", code: "lab-order-transmission" }] }, basedOn: [{ reference: `Task/${original.id}` }] });
  f.seed<Task>({ ...original, id: "foreign-author", status: "completed", basedOn: [{ reference: `Task/${original.id}` }], meta: { ...original.meta, author: { reference: "Practitioner/forger" } } });
  const result = await run(f, "complete", undefined, original.id);
  assert.equal(result.status, 200); assert.equal(result.body.task.status, "completed"); assert.deepEqual(f.owners("r1"), ["D"]);
});
test("L24b: a live service-authored correction stops Complete before every write", async () => {
  const f = fixture(); const original = await attachPending(f);
  f.seed<Task>({ ...original, id: "live-correction", basedOn: [{ reference: `Task/${original.id}` }] });
  const count = f.writes.length; const result = await run(f, "complete", undefined, original.id);
  assert.equal(result.status, 409); assert.equal(result.body.phase, "takeover-in-progress"); assert.equal(f.writes.length, count);
});
test("L12/L14: landed and unsent detach intents use the expected-version fence classifier", async () => {
  for (const landed of [true, false]) {
    const f = fixture(1); let once = true;
    f.seed<Person>({ ...f.S, extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/guarantor-link-epoch", valueString: "a-prior-run" }] });
    const lose = async (w: Write) => { if (once && w.resource.resourceType === "Person" && w.resource.id === "S") { once = false; throw new Error("Synthetic transport loss"); } };
    if (landed) f.afterWrite = lose; else f.beforeWrite = lose;
    const start = await run(f, "create", f.input()); f.afterWrite = undefined; f.beforeWrite = undefined;
    assert.equal(start.status, 409); const count = f.writes.length;
    const result = await run(f, "complete", undefined, start.body.task.id);
    assert.equal(result.status, 200); assert.equal(result.body.task.status, "completed");
    const detachIntent = JSON.parse(result.body.task.extension[0].valueString).intents.find((i: any) => i.phase === "detaching");
    assert.equal(detachIntent.disposition, landed ? "landed" : "not-landed");
    const fence = f.writes.slice(count).find(w => w.resource.resourceType === "Person" && w.resource.id === "S")!;
    assert.equal(fence.expected, "1"); assert.equal(fence.status, landed ? 412 : 200); assert.deepEqual(f.owners("r1"), ["D"]);
  }
});
test("L13: an unresolved changed child intent is interference with no further domain writes", async () => {
  const f = fixture(1); let once = true;
  f.afterWrite = async w => { if (once && w.resource.resourceType === "RelatedPerson") { once = false; throw new Error("Synthetic lost claim response"); } };
  const start = await run(f, "create", f.input()); f.afterWrite = undefined;
  f.compete("RelatedPerson/r1", c => ({ ...c, extension: c.extension.filter((e: Extension) => e.url !== CLAIM) }));
  const count = f.writes.length; const result = await run(f, "complete", undefined, start.body.task.id);
  assert.equal(result.status, 409); assert.equal(result.body.phase, "interfered");
  assert.equal(f.writes.slice(count).filter(w => w.resource.resourceType !== "Task").length, 0);
  assert.ok(f.audits.some(r => r.eventType === "guarantor.link.interfered" && r.actionReason.includes("RelatedPerson/r1")));
});

const correctionInput = () => ({ operationId: randomUUID(), reason: "Synthetic correction confirmed by staff" });
const claim = (r: Resource) => (r as RelatedPerson).extension?.find(e => e.url === CLAIM)?.valueReference?.reference;
test("L26: pending Correct detaches a landed attachment before returning children to retained S", async () => {
  const f = fixture(1); let once = true;
  f.beforeWrite = async w => { if (once && w.resource.resourceType === "RelatedPerson" && w.resource.name?.[0]?.family === "Destination") { once = false; f.compete("RelatedPerson/r1", r => ({ ...r, name: [{ family: "Competitor" }] })); } };
  const first = await run(f, "create", f.input()); f.beforeWrite = undefined;
  assert.equal(first.body.phase, "project-pending"); assert.deepEqual(f.owners("r1"), ["D"]);
  const count = f.writes.length; const corrected = await run(f, "correct", correctionInput(), first.body.task.id);
  assert.equal(corrected.status, 200); assert.equal(corrected.body.task.status, "completed"); assert.deepEqual(f.owners("r1"), ["S"]);
  assert.equal(f.get<Person>("Person/S").active, true); assert.equal(f.get<Task>(`Task/${first.body.task.id}`).status, "cancelled");
  const changes = f.writes.slice(count).filter(w => w.resource.resourceType === "Person" && w.status === 200);
  const detach = changes.findIndex(w => w.resource.id === "D" && !(w.resource as Person).link?.some(l => l.target.reference === "RelatedPerson/r1"));
  const attach = changes.findIndex(w => w.resource.id === "S" && (w.resource as Person).link?.some(l => l.target.reference === "RelatedPerson/r1"));
  assert.ok(detach >= 0 && attach > detach);
  const bad = await run(f, "correct", correctionInput(), corrected.body.task.id); assert.equal(bad.status, 422);
});
test("S6: completed Correct restores retained S, preserves D sibling, and refuses a later owner", async () => {
  for (const laterMove of [false, true]) {
    const f = fixture(1); const first = await run(f, "create", f.input("consolidate"));
    f.compete("RelatedPerson/k", k => ({ ...k, name: [{ family: "Later sibling edit" }] })); const sibling = f.get("RelatedPerson/k");
    if (laterMove) { f.compete("Person/D", d => ({ ...d, link: d.link.filter((l: any) => l.target.reference !== "RelatedPerson/r1") })); f.seed<Person>({ resourceType: "Person", id: "later", link: [{ target: { reference: "RelatedPerson/r1" } }] }); }
    const result = await run(f, "correct", correctionInput(), first.body.task.id);
    assert.equal(result.status, laterMove ? 409 : 200); assert.deepEqual(f.get("RelatedPerson/k"), sibling);
    if (!laterMove) { assert.deepEqual(f.owners("r1"), ["S"]); assert.deepEqual(f.get<RelatedPerson>("RelatedPerson/r1").name, f.S.name); }
  }
});
async function partialFailedCorrection(f: ReturnType<typeof fixture>) {
  const original = await attachPending(f); let stoppedBeforeFailure = false;
  f.beforeWrite = async w => {
    if (w.resource.resourceType === "RelatedPerson" && w.resource.id === "r2" && claim(w.resource) !== `Task/${original.id}`) {
      const count = f.writes.length; const stopped = await run(f, "complete", undefined, original.id);
      assert.equal(stopped.body.phase, "takeover-in-progress"); assert.equal(f.writes.length, count); stoppedBeforeFailure = true;
      f.compete("RelatedPerson/r2", c => ({ ...c, name: [{ family: "Takeover competitor" }] }));
    }
  };
  const correction = await run(f, "correct", correctionInput(), original.id); f.beforeWrite = undefined;
  assert.equal(correction.status, 409); assert.equal(correction.body.task.status, "failed"); assert.equal(correction.body.phase, "takeover-conflict");
  assert.equal(f.get<Task>(`Task/${original.id}`).status, "in-progress"); assert.equal(stoppedBeforeFailure, true);
  return { original, correction: correction.body.task as Task };
}
test("L15/L24a/L25: partial takeover fails while original stays live and descends the orphaned claim", async () => {
  const f = fixture(); const { original } = await partialFailedCorrection(f);
  const result = await run(f, "complete", undefined, original.id); assert.equal(result.status, 200);
  assert.equal(result.body.task.status, "completed"); for (const id of f.ids) assert.deepEqual(f.owners(id), ["D"]);
});
test("L27/L29: one or two descent refusals resolve each intent; a later Complete is live", async () => {
  for (const conflicts of [1, 2]) {
    const f = fixture(); const { original, correction } = await partialFailedCorrection(f); let refusals = 0;
    f.beforeWrite = async w => { if (refusals < conflicts && w.resource.resourceType === "RelatedPerson" && w.resource.id === "r1" && claim(w.resource) === `Task/${original.id}` && claim(f.get("RelatedPerson/r1")) === `Task/${correction.id}`) { refusals++; f.compete("RelatedPerson/r1", c => ({ ...c, name: [{ family: `Recovery competitor ${refusals}` }] })); } };
    const first = await run(f, "complete", undefined, original.id); f.beforeWrite = undefined;
    assert.equal(refusals, conflicts);
    if (conflicts === 2) {
      assert.equal(first.status, 409); assert.equal(first.body.phase, "recovery-conflict"); assert.equal(first.body.task.status, "in-progress");
      const journal = JSON.parse(first.body.task.extension[0].valueString);
      assert.equal(journal.intents.filter((i: any) => !i.disposition).length, 0);
      const rejected = journal.intents.filter((i: any) => i.target === "RelatedPerson/r1" && i.responseStatus === 412);
      assert.equal(rejected.length, 2); assert.ok(rejected.every((i: any) => i.disposition === "rejected"));
      assert.notEqual(rejected[0].expectedVersion, rejected[1].expectedVersion); assert.notEqual(rejected[0].id, rejected[1].id);
      const next = await run(f, "complete", undefined, original.id); assert.equal(next.status, 200); assert.equal(next.body.task.status, "completed");
    } else assert.equal(first.body.task.status, "completed");
    for (const id of f.ids) assert.deepEqual(f.owners(id), ["D"]);
  }
});
test("L28: a missing checkpointed claim is reclaimed only on an unowned child without another live claim", async () => {
  for (const foreign of [false, true]) {
    const f = fixture(); const task = await attachPending(f);
    if (foreign) f.seed<Task>({ ...task, id: "foreign-live" });
    f.compete("RelatedPerson/r1", c => ({ ...c, extension: [...c.extension.filter((e: Extension) => e.url !== CLAIM), ...(foreign ? [{ url: CLAIM, valueReference: { reference: "Task/foreign-live" } }] : [])] }));
    const result = await run(f, "complete", undefined, task.id);
    assert.equal(result.status, foreign ? 409 : 200); assert.equal(result.body.task.status, foreign ? "in-progress" : "completed");
    if (foreign) assert.equal(result.body.phase, "interfered"); else for (const id of f.ids) assert.deepEqual(f.owners(id), ["D"]);
  }
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
test("L1: two admitted starters produce one source detach and one completed operation", { timeout: 5000 }, async () => {
  const f = fixture(1); f.seed<Person>({ ...f.D, id: "D2", link: [] });
  const a = f.input(), b = { ...f.input(), destinationPersonId: "D2" }; b.expected["Person/D2"] = "1"; delete b.expected["Person/D"];
  const admitted = deferred(), aClaim = deferred(); let records = 0;
  const isB = (ref: string | undefined) => ref && f.get<Task>(ref).identifier?.some(i => i.value === b.operationId);
  f.beforeWrite = async w => { if (w.resource.resourceType === "Task" && !w.resource.id) { if (++records === 2) admitted.resolve(); await admitted.promise; }
    if (w.resource.resourceType === "RelatedPerson" && isB(claim(w.resource))) await aClaim.promise; };
  f.afterWrite = async w => { if (w.resource.resourceType === "RelatedPerson" && !isB(claim(w.resource)) && w.status === 200) aClaim.resolve(); };
  const [first, second] = await Promise.all([run(f, "create", a), run(f, "create", b)]);
  assert.equal(f.writes.filter(w => w.resource.resourceType === "Person" && w.resource.id === "S").length, 1, "loser never reaches source detach");
  assert.equal(first.body.task.status, "completed"); assert.equal(second.body.task.status, "failed"); assert.equal(second.body.phase, "claim-conflict"); assert.equal(f.owners("r1").length, 1);
});
test("L2: sorted claims give a winner with two shared children and opposed request orders", { timeout: 5000 }, async () => {
  const f = fixture(4); f.seed<Person>({ ...f.D, id: "D2", link: [] });
  const a = f.input("transfer", ["r1", "r2", "r3"]), b = { ...f.input("transfer", ["r4", "r3", "r2"]), destinationPersonId: "D2" }; b.expected["Person/D2"] = "1"; delete b.expected["Person/D"];
  const admitted = deferred(); let records = 0;
  const attempts = new Map<string, number>(), responses = new Map<string, number>(); const rounds = [deferred(), deferred(), deferred()];
  const isClaimWrite = (w: Write) => w.resource.resourceType === "RelatedPerson" && claim(w.resource) && JSON.parse(f.get<Task>(claim(w.resource)!).extension![0].valueString!).intents.at(-1).phase === "claiming";
  f.beforeWrite = async w => {
    if (w.resource.resourceType === "Task" && !w.resource.id) { if (++records === 2) admitted.resolve(); await admitted.promise; }
    if (isClaimWrite(w)) { const ref = claim(w.resource)!; const count = (attempts.get(ref) ?? 0) + 1; attempts.set(ref, count); if (count > 1) await rounds[count - 2].promise; }
  };
  f.afterWrite = async w => { if (isClaimWrite(w)) { const ref = claim(w.resource)!; responses.set(ref, (responses.get(ref) ?? 0) + 1); for (let i = 0; i < rounds.length; i++) if (responses.size === 2 && [...responses.values()].every(n => n >= i + 1)) rounds[i].resolve(); } };
  const results = await Promise.all([run(f, "create", a), run(f, "create", b)]);
  assert.equal(results.filter(r => r.body.task.status === "completed").length, 1, "one operation wins rather than both failing");
  assert.equal(results.filter(r => r.body.task.status === "failed").length, 1);
  for (const id of f.ids) assert.equal(f.owners(id).length, 1);
});
test("L5: D changes after r1 projection so no stale r2 projection is submitted", async () => {
  const f = fixture(); let changed = false;
  f.afterWrite = async w => { if (!changed && w.resource.resourceType === "RelatedPerson" && w.resource.id === "r1" && w.resource.name?.[0]?.family === "Destination") { changed = true; f.compete("Person/D", p => ({ ...p, name: [{ family: "New generation" }] })); } };
  const first = await run(f, "create", f.input()); f.afterWrite = undefined;
  assert.equal(f.writes.filter(w => w.resource.resourceType === "RelatedPerson" && w.resource.id === "r2" && w.resource.name?.[0]?.family === "Destination").length, 0, "no stale r2 PUT");
  assert.equal(first.body.phase, "project-pending"); const result = await run(f, "complete", undefined, first.body.task.id); assert.equal(result.status, 200);
  for (const id of f.ids) assert.deepEqual(f.get<RelatedPerson>(`RelatedPerson/${id}`).name, [{ family: "New generation" }]);
});
test("L16/L20: another claim or name edit after verification refuses release and completion audit", async () => {
  for (const otherClaim of [true, false]) {
    const f = fixture(1); let once = true, projected = false;
    f.afterWrite = async w => { if (w.resource.resourceType === "RelatedPerson" && w.resource.name?.[0]?.family === "Destination" && claim(w.resource)) projected = true; };
    f.afterRead = async r => { if (once && projected && r.resourceType === "Person" && r.id === "D") { once = false; f.compete("RelatedPerson/r1", c => otherClaim ? { ...c, extension: c.extension.map((e: Extension) => e.url === CLAIM ? { url: CLAIM, valueReference: { reference: "Task/competitor" } } : e) } : { ...c, name: [{ family: "Later staff edit" }] }); } };
    const result = await run(f, "create", f.input()); f.afterRead = undefined; f.afterWrite = undefined;
    assert.equal(once, false, "competitor lands after the trailing verification read, independently of release");
    assert.equal(result.status, 409); assert.equal(result.body.task.status, "in-progress"); assert.equal(result.body.phase, "project-pending");
    assert.equal(f.writes.find(w => w.resource.resourceType === "RelatedPerson" && !claim(w.resource))?.status, 412);
    assert.equal(f.audits.filter(r => r.eventType === "guarantor.link.completed").length, 0); assert.ok(f.audits.some(r => r.eventType === "guarantor.link.pending"));
  }
});
test("L23: D editing after verify is later drift; conditional child release still completes", async () => {
  const f = fixture(1); let once = true;
  f.beforeWrite = async w => { if (once && w.resource.resourceType === "RelatedPerson" && !claim(w.resource)) { once = false; f.compete("Person/D", p => ({ ...p, name: [{ family: "Later D edit" }] })); } };
  const result = await run(f, "create", f.input()); assert.equal(result.status, 200); assert.equal(result.body.task.status, "completed");
  assert.deepEqual(f.get<RelatedPerson>("RelatedPerson/r1").name, [{ family: "Destination" }]); assert.deepEqual(f.get<Person>("Person/D").name, [{ family: "Later D edit" }]);
});
test("L19: a revoked business action refuses before any read or write", async () => {
  const f = fixture(); const { handleGuarantorOperation } = await import("../src/clinic/guarantor-link-operation.js");
  const result = await handleGuarantorOperation(f.deps as never, { ...staff, businessActions: [] } as never, { action: "create", body: f.input() });
  assert.equal(result.status, 403); assert.equal(f.writes.length, 0);
});
test("S4/status: a missing operation is inert and a staff-authored copied Task cannot activate claims", async () => {
  const f = fixture(1); const task = await attachPending(f); f.compete(`Task/${task.id}`, t => ({ ...t }));
  const inert = await run(f, "status", undefined, task.id); assert.equal(inert.status, 200); assert.equal(inert.body.active, false);
  const missing = await run(f, "status", undefined, "missing"); assert.equal(missing.status, 404);
});
test("L15: correction fences a paused Complete before its already-intended destination PUT", { timeout: 5000 }, async () => {
  const f = fixture(1); const original = await attachPending(f); const paused = deferred(), resume = deferred(); let blocked: Write | undefined;
  f.beforeWrite = async w => { if (!blocked && w.resource.resourceType === "Person" && w.resource.id === "D" && w.resource.link?.some(l => l.target.reference === "RelatedPerson/r1")) { blocked = w; paused.resolve(); await resume.promise; } };
  const running = run(f, "complete", undefined, original.id); await paused.promise;
  const correction = await run(f, "correct", correctionInput(), original.id); assert.equal(correction.status, 200);
  resume.resolve(); await running; f.beforeWrite = undefined;
  assert.equal(blocked?.status, 412, "paused earlier Person write is refused by the correction fence"); assert.deepEqual(f.owners("r1"), ["S"]);
  const final = f.get<Task>(`Task/${original.id}`); const intents = JSON.parse(final.extension![0].valueString!).intents;
  const refused = intents.filter((i: any) => i.target === "Person/D" && i.phase === "attaching").at(-1);
  assert.equal(final.status, "cancelled"); assert.equal(refused.disposition, "rejected"); assert.equal(refused.responseStatus, 412);
});
test("L24c: completed correction causes one cancel attempt, never an attempted fence intent", { timeout: 5000 }, async () => {
  const f = fixture(1); const original = await attachPending(f); const paused = deferred(), resume = deferred(); let once = true;
  f.beforeSearch = async (type, params) => { if (once && type === "Task" && params["based-on"] === `Task/${original.id}`) { once = false; paused.resolve(); await resume.promise; } };
  const running = run(f, "complete", undefined, original.id); await paused.promise;
  const correction = await run(f, "correct", correctionInput(), original.id); assert.equal(correction.status, 200); const count = f.writes.length;
  resume.resolve(); await running; f.beforeSearch = undefined;
  const tail = f.writes.slice(count); assert.equal(tail.length, 1); assert.equal(tail[0].resource.resourceType, "Task");
  assert.equal((tail[0].resource as Task).status, "cancelled"); assert.equal((tail[0].resource as Task).businessStatus?.text, "corrected"); assert.equal(tail[0].status, 412);
});
test("S6 bounded cancellation: three fresh versions and intents, then pending; later Complete finishes", async () => {
  const f = fixture(1); const original = await attachPending(f); let conflicts = 0;
  f.beforeWrite = async w => { if (conflicts < 3 && w.resource.resourceType === "Task" && w.resource.id === original.id && w.resource.status === "cancelled") { conflicts++; f.compete(`Task/${original.id}`, t => ({ ...t, businessStatus: { text: `Original runner ${conflicts}` } }), SERVICE); } };
  const result = await run(f, "correct", correctionInput(), original.id); f.beforeWrite = undefined;
  assert.equal(conflicts, 3); assert.equal(result.status, 409); assert.equal(result.body.phase, "recovery-conflict"); assert.equal(result.body.task.status, "in-progress");
  const attempts = JSON.parse(result.body.task.extension[0].valueString).intents.filter((i: any) => i.phase === "cancel-original");
  assert.equal(attempts.length, 3); assert.equal(new Set(attempts.map((i: any) => i.expectedVersion)).size, 3); assert.ok(attempts.every((i: any) => i.disposition === "rejected" && i.responseStatus === 412));
  const next = await run(f, "complete", undefined, result.body.task.id); assert.equal(next.status, 200); assert.equal(next.body.task.status, "completed"); assert.equal(f.get<Task>(`Task/${original.id}`).status, "cancelled");
});
test("S6 crash prefix: Complete finishes a partial takeover after a lost or unsent claim response", async () => {
  for (const landed of [true, false]) {
    const f = fixture(); const original = await attachPending(f); let once = true;
    const lose = async (w: Write) => { if (once && w.resource.resourceType === "RelatedPerson" && w.resource.id === "r1") { once = false; throw new Error("Synthetic takeover response loss"); } };
    if (landed) f.afterWrite = lose; else f.beforeWrite = lose;
    const correction = await run(f, "correct", correctionInput(), original.id); f.afterWrite = undefined; f.beforeWrite = undefined;
    assert.equal(correction.status, 409); assert.equal(correction.body.phase, "claim-pending"); assert.equal(correction.body.task.status, "in-progress");
    assert.equal(f.get<Task>(`Task/${original.id}`).status, "in-progress");
    const completed = await run(f, "complete", undefined, correction.body.task.id);
    assert.equal(completed.status, 200); assert.equal(completed.body.task.status, "completed");
    assert.equal(f.get<Task>(`Task/${original.id}`).status, "cancelled");
    for (const id of f.ids) { assert.deepEqual(f.owners(id), ["S"]); assert.equal(claim(f.get(`RelatedPerson/${id}`)), undefined); }
  }
});
test("S6 resumed takeover refusal fails only the correction before ownership and preserves original recovery", async () => {
  const f = fixture(); const original = await attachPending(f); let once = true;
  f.afterWrite = async w => { if (once && w.resource.resourceType === "RelatedPerson" && w.resource.id === "r1") { once = false; throw new Error("Synthetic takeover response loss"); } };
  const correction = await run(f, "correct", correctionInput(), original.id); f.afterWrite = undefined;
  f.beforeWrite = async w => { if (w.resource.resourceType === "RelatedPerson" && w.resource.id === "r2") f.compete("RelatedPerson/r2", r => ({ ...r, name: [{ family: "Takeover competitor" }] })); };
  const resumed = await run(f, "complete", undefined, correction.body.task.id); f.beforeWrite = undefined;
  assert.equal(resumed.body.task.status, "failed"); assert.equal(resumed.body.phase, "takeover-conflict");
  assert.equal(f.get<Task>(`Task/${original.id}`).status, "in-progress");
  const recovered = await run(f, "complete", undefined, original.id); assert.equal(recovered.status, 200);
  for (const id of f.ids) assert.deepEqual(f.owners(id), ["D"]);
});
test("L15 fresh retry: a partially running correction stops the old runner before a fresh destination write", { timeout: 5000 }, async () => {
  const f = fixture(1); const original = await attachPending(f);
  const aPaused = deferred(), aResume = deferred(), cPaused = deferred(), cResume = deferred(); let aWrite: Write | undefined, cWrite: Write | undefined;
  f.beforeWrite = async w => {
    if (w.resource.resourceType !== "Person" || !w.resource.link?.some(l => l.target.reference === "RelatedPerson/r1")) return;
    if (w.resource.id === "D" && !aWrite) { aWrite = w; aPaused.resolve(); await aResume.promise; }
    if (w.resource.id === "S" && !cWrite) { cWrite = w; cPaused.resolve(); await cResume.promise; }
  };
  const a = run(f, "complete", undefined, original.id); await aPaused.promise;
  const c = run(f, "correct", correctionInput(), original.id); await cPaused.promise;
  aResume.resolve(); const old = await a;
  cResume.resolve(); const corrected = await c; f.beforeWrite = undefined;
  assert.equal(aWrite?.status, 412); assert.equal(old.body.phase, "takeover-in-progress");
  assert.equal(corrected.status, 200); assert.deepEqual(f.owners("r1"), ["S"]);
  assert.equal(f.writes.filter(w => w.resource.resourceType === "Person" && w.resource.id === "D" && w.resource.link?.some(l => l.target.reference === "RelatedPerson/r1") && w.status === 200).length, 0);
});
test("S3 released children: Complete preserves later transfers after partial release or an unsent terminal write", async () => {
  for (const allReleased of [true, false]) for (const laterDestination of ["E", "S"]) {
    const f = fixture(3); f.seed<Person>({ ...f.D, id: "E", link: [] }); let once = true;
    f.beforeWrite = async w => {
      if (allReleased && once && w.resource.resourceType === "Task" && w.resource.status === "completed") { once = false; throw new Error("Synthetic unsent terminal write"); }
      if (!allReleased && once && w.resource.resourceType === "RelatedPerson" && w.resource.id === "r2" && !claim(w.resource)) { once = false; f.compete("RelatedPerson/r2", r => ({ ...r, name: [{ family: "Later edit blocks release" }] })); }
    };
    const initial = f.input("transfer", ["r1", "r2"]); await run(f, "create", initial); f.beforeWrite = undefined;
    const original = [...f.data.values()].find((r): r is Task => r.resourceType === "Task" && r.identifier?.some(i => i.value === initial.operationId))!;
    assert.equal(original.status, "in-progress"); assert.equal(claim(f.get("RelatedPerson/r1")), undefined);
    const later = { ...f.input("transfer", ["r1"]), sourcePersonId: "D", destinationPersonId: laterDestination,
      expected: Object.fromEntries(["Person/D", `Person/${laterDestination}`, "RelatedPerson/r1"].map(ref => [ref, f.get(ref).meta!.versionId])) };
    const next = await run(f, "create", later); assert.equal(next.status, 200); const childAfterLater = f.get("RelatedPerson/r1"); const count = f.writes.length;
    const completed = await run(f, "complete", undefined, original.id); assert.equal(completed.status, 200); assert.equal(completed.body.task.status, "completed");
    assert.deepEqual(f.owners("r1"), [laterDestination]); assert.deepEqual(f.get("RelatedPerson/r1"), childAfterLater);
    assert.equal(f.writes.slice(count).filter(w => w.resource.resourceType === "RelatedPerson" && w.resource.id === "r1").length, 0);
    assert.deepEqual(f.owners("r2"), ["D"]); assert.equal(claim(f.get("RelatedPerson/r2")), undefined);
  }
});
test("L29: double re-claim refusals and a lost successful descent retry remain resumable", async () => {
  for (const reclaim of [true, false]) {
    const f = fixture(); const original = reclaim ? await attachPending(f) : (await partialFailedCorrection(f)).original;
    if (reclaim) f.compete("RelatedPerson/r1", r => ({ ...r, extension: r.extension.filter((e: Extension) => e.url !== CLAIM) }));
    let refusals = 0, lost = false;
    f.beforeWrite = async w => { if (refusals < (reclaim ? 2 : 1) && w.resource.resourceType === "RelatedPerson" && w.resource.id === "r1" && claim(w.resource) === `Task/${original.id}`) { refusals++; f.compete("RelatedPerson/r1", r => ({ ...r, name: [{ family: `Retry competitor ${refusals}` }] })); } };
    f.afterWrite = async w => { if (!reclaim && !lost && w.resource.resourceType === "RelatedPerson" && w.resource.id === "r1" && w.status === 200 && claim(w.resource) === `Task/${original.id}`) { lost = true; throw new Error("Synthetic loss after successful descent retry"); } };
    const first = await run(f, "complete", undefined, original.id); f.beforeWrite = undefined; f.afterWrite = undefined;
    assert.equal(first.status, 409); assert.equal(first.body.phase, "recovery-conflict"); assert.equal(first.body.task.status, "in-progress");
    const journal = JSON.parse(first.body.task.extension[0].valueString);
    assert.equal(journal.intents.filter((i: any) => i.responseStatus === 412 && i.disposition === "rejected" && i.target === "RelatedPerson/r1").length, reclaim ? 2 : 1);
    assert.equal(journal.intents.filter((i: any) => !i.disposition).length, reclaim ? 0 : 1);
    const next = await run(f, "complete", undefined, original.id); assert.equal(next.status, 200); assert.equal(next.body.task.status, "completed");
    for (const id of f.ids) assert.deepEqual(f.owners(id), ["D"]);
  }
});
test("S3 intent rule: a definite server error is rejected history, not an unresolved response", async () => {
  const f = fixture(1); let once = true;
  f.beforeWrite = async w => { if (once && w.resource.resourceType === "RelatedPerson") { once = false; throw Object.assign(new Error("FHIR 503"), { status: 503 }); } };
  const response = await run(f, "create", f.input()); f.beforeWrite = undefined;
  assert.equal(response.body.phase, "claim-pending"); const intents = JSON.parse(response.body.task.extension[0].valueString).intents;
  assert.equal(intents.length, 1); assert.equal(intents[0].disposition, "rejected"); assert.equal(intents[0].responseStatus, 503);
  assert.equal(f.writes.filter(w => w.resource.resourceType === "RelatedPerson").length, 1);
});
test("S3 checkpoint refusal stops immediately without replaying a stale Task version", async () => {
  const f = fixture(1); let once = true;
  f.beforeWrite = async w => { if (once && w.resource.resourceType === "Task" && w.resource.extension?.length) { once = false; f.compete(`Task/${w.resource.id}`, t => ({ ...t, businessStatus: { text: "Other completion runner" } }), SERVICE); } };
  const result = await run(f, "create", f.input()); f.beforeWrite = undefined;
  assert.equal(result.status, 412);
  assert.equal(f.writes.filter(w => w.resource.resourceType === "Task" && w.expected).length, 1);
  assert.equal(f.writes.filter(w => w.resource.resourceType !== "Task").length, 0);
});
test("S3 late successful release checkpoints its result without completing or auditing twice", { timeout: 5000 }, async () => {
  const f = fixture(1), paused = deferred(), resume = deferred(); let held = false;
  f.afterWrite = async w => {
    if (!held && w.resource.resourceType === "RelatedPerson" && !claim(w.resource)) {
      held = true; paused.resolve(); await resume.promise;
    }
  };
  const running = run(f, "create", f.input()); await paused.promise;
  const task = [...f.data.values()].find(r => r.resourceType === "Task") as Task;
  const recovery = await run(f, "complete", undefined, task.id);
  assert.equal(recovery.status, 200); assert.equal(recovery.body.task.status, "completed");
  assert.equal(f.audits.filter(r => r.eventType === "guarantor.link.completed").length, 1);
  const count = f.writes.length;
  resume.resolve(); const late = await running; f.afterWrite = undefined;
  assert.equal(late.status, 200); assert.equal(late.body.task.status, "completed");
  assert.equal(f.audits.filter(r => r.eventType === "guarantor.link.completed").length, 1);
  const tail = f.writes.slice(count);
  assert.equal(tail.length, 1, "only the late response journal checkpoint may write");
  assert.equal(tail[0].resource.resourceType, "Task");
  assert.deepEqual(f.owners("r1"), ["D"]);
  const final = f.get<Task>(`Task/${task.id}`);
  const release = JSON.parse(final.extension![0].valueString!).intents.find((i: any) => i.phase === "releasing");
  assert.equal(release.disposition, "landed"); assert.equal(release.responseStatus, 200);
});
test("L17: a genuine claim copied to an unlisted child is inert; an untrusted Task needs no readable plan", async () => {
  const f = fixture(); const original = await attachPending(f, ["r1"]);
  f.compete("RelatedPerson/r2", r => ({ ...r, extension: [...r.extension, { url: CLAIM, valueReference: { reference: `Task/${original.id}` } }] }));
  const count = f.writes.length; const preview = await run(f, "preview", f.input("transfer", ["r2"]));
  assert.equal(preview.status, 200); assert.equal(f.writes.length, count);
  f.seed<Task>({ resourceType: "Task", id: "fake", intent: "order", status: "in-progress", code: { coding: [{ system: CODE, code: "transfer" }] }, meta: { author: { reference: "Practitioner/forger" } } });
  const fake = await run(f, "status", undefined, "fake"); assert.equal(fake.status, 200); assert.equal(fake.body.active, false);
});
test("S5 retry classification: a fresh foreign live claim stops a recovery Person retry", async () => {
  const f = fixture(1); const original = await attachPending(f); f.seed<Task>({ ...original, id: "other-live" }); let once = true;
  f.beforeWrite = async w => { if (once && w.resource.resourceType === "Person" && w.resource.id === "D" && w.resource.link?.some(l => l.target.reference === "RelatedPerson/r1")) { once = false; f.compete("Person/D", p => ({ ...p, name: [{ family: "Retry competitor" }] })); f.compete("RelatedPerson/r1", r => ({ ...r, extension: [...r.extension.filter((e: Extension) => e.url !== CLAIM), { url: CLAIM, valueReference: { reference: "Task/other-live" } }] })); } };
  const count = f.writes.length; const result = await run(f, "complete", undefined, original.id); f.beforeWrite = undefined;
  assert.equal(result.status, 409); assert.equal(result.body.phase, "interfered");
  assert.equal(f.writes.slice(count).filter(w => w.resource.resourceType === "Person" && w.resource.id === "D" && w.resource.link?.some(l => l.target.reference === "RelatedPerson/r1") && w.status === 200).length, 0);
  assert.deepEqual(f.owners("r1"), []);
});
test("L15 pre-takeover retry: the correction record stops a fresh retry even before its first claim lands", { timeout: 5000 }, async () => {
  const f = fixture(1); const original = await attachPending(f);
  const aPaused = deferred(), aResume = deferred(), cPaused = deferred(), cResume = deferred(); let aWrite: Write | undefined, stoppedC = false;
  f.beforeWrite = async w => {
    if (!aWrite && w.resource.resourceType === "Person" && w.resource.id === "D" && w.resource.link?.some(l => l.target.reference === "RelatedPerson/r1")) { aWrite = w; aPaused.resolve(); await aResume.promise; }
    if (!stoppedC && w.resource.resourceType === "RelatedPerson" && claim(w.resource) && claim(w.resource) !== `Task/${original.id}`) { stoppedC = true; cPaused.resolve(); await cResume.promise; }
  };
  const a = run(f, "complete", undefined, original.id); await aPaused.promise;
  const c = run(f, "correct", correctionInput(), original.id); await cPaused.promise;
  assert.equal(claim(f.get("RelatedPerson/r1")), `Task/${original.id}`);
  aResume.resolve(); const old = await a; cResume.resolve(); const corrected = await c; f.beforeWrite = undefined;
  assert.equal(aWrite?.status, 412); assert.equal(old.body.phase, "takeover-in-progress");
  assert.equal(corrected.status, 200); assert.deepEqual(f.owners("r1"), ["S"]);
});
