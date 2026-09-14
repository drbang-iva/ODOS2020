import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Person, RelatedPerson, Resource, Task } from "@medplum/fhirtypes";
import { ResponsiblePartiesControl } from "../src/components/patient/ResponsiblePartiesControl";
import { loadGuarantor, repairGuarantor, saveGuarantor, type GuarantorSnapshot } from "../src/lib/guarantor-editor";

const claimUrl = "https://odos2020.com/fhir/StructureDefinition/guarantor-link-claim";
const operationId = "06b18b36-e59d-4aaf-8d32-59cbce7abf86";
const old = { name: [{ given: ["Old"], family: "Guardian" }], telecom: [{ system: "phone" as const, value: "+15555550101" }], address: [{ line: ["Old street"] }] };
const destination = { name: [{ given: ["Destination"], family: "Guardian" }], telecom: [{ system: "phone" as const, value: "+15555550102" }], address: [{ line: ["Destination street"] }] };

class Fixture {
  records = new Map<string, Resource>();
  writes: { path: string; method: string; version: string | null; body?: unknown; status?: number }[] = [];
  reads: string[] = [];
  before?: (path: string, method: string) => void;
  action?: (path: string, body: unknown) => Response;
  operationStatus = 200;
  operation = {
    task: { resourceType: "Task", id: operationId, status: "in-progress", intent: "order", code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/guarantor-link-operation", code: "transfer" }] } } as Task,
    active: true, kind: "transfer" as "transfer" | "consolidate" | "correct", phase: "attach-pending", sourcePersonId: "source", destinationPersonId: "destination", relatedPersonIds: ["a", "b"],
    patients: [{ relatedPersonId: "a", patientId: "sam", name: "Sam Synthetic" }, { relatedPersonId: "b", patientId: "leo", name: "Leo Synthetic" }],
  };
  constructor() {
    this.put({ resourceType: "Person", id: "source", meta: { versionId: "1" }, ...old, link: ["a", "b"].map(id => ({ target: { reference: `RelatedPerson/${id}` } })) });
    this.put({ resourceType: "Person", id: "destination", meta: { versionId: "1" }, ...destination });
    for (const [id, patientId, name] of [["a", "sam", "Sam"], ["b", "leo", "Leo"]]) {
      this.put({ resourceType: "Patient", id: patientId, meta: { versionId: "1" }, name: [{ given: [name], family: "Synthetic" }] });
      this.put({ resourceType: "RelatedPerson", id, meta: { versionId: "1" }, ...old, patient: { reference: `Patient/${patientId}` }, active: id === "a", period: { start: "2020-01-01" }, extension: [{ url: "https://example.test/sentinel", valueString: id }] });
    }
  }
  put(resource: Resource) { this.records.set(`${resource.resourceType}/${resource.id}`, structuredClone(resource)); }
  get<T extends Resource>(path: string): T { return structuredClone(this.records.get(path)) as T; }
  change(path: string, values: object) { const current = this.get(path); this.put({ ...current, ...values, meta: { versionId: String(Number(current.meta!.versionId) + 1) } } as Resource); }
  claim(id: string) {
    const child = this.get<RelatedPerson>(`RelatedPerson/${id}`);
    this.change(`RelatedPerson/${id}`, { extension: [...child.extension ?? [], { url: claimUrl, valueReference: { reference: `Task/${operationId}` } }] });
  }
  finish() {
    this.operation.active = false;
    this.operation.task.status = "completed";
    this.change("Person/source", { link: [] });
    this.change("Person/destination", { link: ["a", "b"].map(id => ({ target: { reference: `RelatedPerson/${id}` } })) });
    for (const id of ["a", "b"]) this.change(`RelatedPerson/${id}`, { ...destination, extension: this.get<RelatedPerson>(`RelatedPerson/${id}`).extension!.filter(e => e.url !== claimUrl) });
  }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://synthetic.test");
    const path = url.pathname.replace("/fhir/R4/", "");
    const method = init?.method ?? "GET";
    this.before?.(path, method);
    if (method === "GET") this.reads.push(path);
    if (path.startsWith("/guarantors/link-operations/")) {
      assert.ok(path.startsWith(`/guarantors/link-operations/${operationId}`));
      if (method === "GET") return Response.json(this.operationStatus === 200 ? this.operation : { error: "Operation unavailable" }, { status: this.operationStatus });
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      this.writes.push({ path, method, body, version: new Headers(init?.headers).get("If-Match") });
      return this.action?.(path, body) ?? Response.json(this.operation);
    }
    if (method === "PUT") {
      const before = this.get(path);
      const version = new Headers(init?.headers).get("If-Match");
      const body = JSON.parse(String(init?.body));
      const status = version === `W/"${before.meta?.versionId}"` ? 200 : 412;
      this.writes.push({ path, method, version, body, status });
      if (status === 412) return Response.json({}, { status });
      this.change(path, body);
      return Response.json(this.get(path));
    }
    assert.equal(method, "GET");
    if (path === "Person" || path === "RelatedPerson") {
      const resources = [...this.records.values()].filter(resource => path === "Person"
        ? resource.resourceType === "Person" && resource.link?.some(link => link.target.reference === url.searchParams.get("link"))
        : resource.resourceType === "RelatedPerson" && resource.patient.reference === url.searchParams.get("patient"));
      return Response.json({ resourceType: "Bundle", type: "searchset", entry: resources.map(resource => ({ resource })) });
    }
    return this.records.has(path) ? Response.json(this.get(path)) : Response.json({}, { status: 404 });
  };
  async snapshot(): Promise<GuarantorSnapshot> {
    const load = await loadGuarantor("a");
    assert.equal(load.kind, "editable");
    if (load.kind !== "editable") throw new Error("Expected editable fixture");
    this.reads = [];
    return load.snapshot;
  }
}

async function usingFixture(run: (data: Fixture) => Promise<void>) {
  const original = globalThis.fetch;
  const data = new Fixture();
  globalThis.fetch = data.fetch;
  try { await run(data); } finally { globalThis.fetch = original; }
}
async function usingEditor(_data: Fixture, run: (renderer: ReactTestRenderer) => Promise<void>) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ResponsiblePartiesControl patientId="sam" />); });
  try { await run(renderer); } finally { act(() => renderer.unmount()); }
}
const button = (renderer: ReactTestRenderer, label: string) => renderer.root.findAllByType("button").find(node => node.children.join("") === label);
const renderedText = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

test("L3 S7: unowned claimed child is pending, names every patient, and Complete reloads the editor", async () => usingFixture(async data => {
  data.change("Person/source", { link: [] });
  data.claim("a");
  const loaded = await loadGuarantor("a");
  assert.equal(loaded.kind, "pending", "an attach-pending child must not be classified missing");
  data.action = path => { assert.equal(path, `/guarantors/link-operations/${operationId}/complete`); data.finish(); return Response.json(data.operation); };
  await usingEditor(data, async renderer => {
    assert.match(renderedText(renderer), /Sam Synthetic/);
    assert.match(renderedText(renderer), /Leo Synthetic/);
    assert.match(renderedText(renderer), new RegExp(operationId));
    assert.equal(button(renderer, "Save guarantor")?.props.disabled, true);
    assert.equal(button(renderer, "Repair guarantor")?.props.disabled, true);
    await act(async () => { await button(renderer, "Save guarantor")!.props.onClick(); await button(renderer, "Repair guarantor")!.props.onClick(); });
    assert.deepEqual(data.writes, []);
    assert.ok(button(renderer, "Correct"));
    const complete = button(renderer, "Complete");
    assert.ok(complete);
    await act(async () => { await complete.props.onClick(); });
    assert.deepEqual(data.writes.map(write => `${write.method} ${write.path}`), [`POST /guarantors/link-operations/${operationId}/complete`]);
    assert.equal(button(renderer, "Complete"), undefined);
    assert.ok(renderer.root.findAllByType("input").length > 0, "Complete must reload actual editable data");
    assert.deepEqual(data.get<RelatedPerson>("RelatedPerson/a").name, destination.name);
  });
}));

test("S7: a claim on another linked child makes the guarantor pending", async () => usingFixture(async data => {
  data.claim("b");
  assert.equal((await loadGuarantor("a")).kind, "pending");
  assert.ok(data.reads.includes(`/guarantors/link-operations/${operationId}`));
  assert.deepEqual(data.writes, []);
}));

test("S7: inert, missing, and copied claims do not suppress ordinary classification", async () => {
  for (const mode of ["inactive", "missing", "unlisted"] as const) await usingFixture(async data => {
    data.claim("a");
    if (mode === "inactive") data.operation.active = false;
    if (mode === "missing") data.operationStatus = 404;
    if (mode === "unlisted") data.operation.relatedPersonIds = ["b"];
    assert.equal((await loadGuarantor("a")).kind, "editable", mode);
    assert.ok(data.reads.includes(`/guarantors/link-operations/${operationId}`), "a claim cannot be judged without the server authority result");
    assert.deepEqual(data.writes, []);
  });
});

test("S7: unreadable operation status remains unknown and does not offer editing", async () => usingFixture(async data => {
  data.claim("a");
  data.operationStatus = 503;
  assert.equal((await loadGuarantor("a")).kind, "unknown");
  await usingEditor(data, async renderer => {
    assert.equal(renderer.root.findAllByType("input").length, 0);
    assert.equal(button(renderer, "Save guarantor")?.props.disabled, true);
    assert.equal(button(renderer, "Complete"), undefined);
  });
}));

test("S7: Correct requires a reason, sends one new operation id, and reloads after a refusal", async () => usingFixture(async data => {
  data.claim("a");
  data.action = (path, body) => {
    assert.equal(path, `/guarantors/link-operations/${operationId}/correct`);
    assert.match((body as { operationId: string }).operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal((body as { reason: string }).reason, "Wrong guarantor selected");
    return Response.json({ error: "Takeover refused; original remains pending" }, { status: 409 });
  };
  await usingEditor(data, async renderer => {
    const correct = button(renderer, "Correct");
    assert.ok(correct);
    assert.equal(correct.props.disabled, true);
    await act(async () => { await correct.props.onClick(); });
    assert.deepEqual(data.writes, [], "a direct handler call also enforces the required reason");
    const reason = renderer.root.findAllByType("label").find(node => node.children[0] === "Reason for correction")!.findByType("input");
    await act(async () => { reason.props.onChange({ target: { value: "  Wrong guarantor selected  " } }); });
    data.reads = [];
    await act(async () => { await button(renderer, "Correct")!.props.onClick(); });
    assert.equal(data.writes.length, 1, "the UI must never retry an operation request");
    assert.ok(data.reads.includes("RelatedPerson/a"), "a refused recovery must reload the section");
    assert.match(renderedText(renderer), /Takeover refused/);
    assert.ok(button(renderer, "Complete"));
  });
}));

test("L4 S7: Repair sees a claim in its fresh read and submits no child PUT", async () => usingFixture(async data => {
  data.change("Person/source", destination);
  const snapshot = await data.snapshot();
  let reads = 0;
  data.before = (path, method) => {
    if (path === "RelatedPerson/a" && method === "GET" && ++reads === 2) { data.before = undefined; data.claim("a"); }
  };
  const result = await repairGuarantor(snapshot);
  assert.deepEqual(data.writes, [], "claim check removal must expose a successful repair PUT in this transport list");
  assert.equal(result.status, "superseded");
  assert.deepEqual(result.children.map(child => child.writeStatus), ["stopped", "stopped"]);
  assert.deepEqual(data.get<RelatedPerson>("RelatedPerson/a").name, old.name);
}));

test("S7: Save fresh-checks claims after the Person save and stops every remaining child", async () => usingFixture(async data => {
  const snapshot = await data.snapshot();
  data.before = (path, method) => {
    if (path === "RelatedPerson/a" && method === "GET" && data.writes.length === 1) { data.before = undefined; data.claim("a"); }
  };
  const result = await saveGuarantor(snapshot, destination);
  assert.deepEqual(data.writes.map(write => write.path), ["Person/source"]);
  assert.equal(result.status, "superseded");
  assert.deepEqual(result.children.map(child => child.writeStatus), ["stopped", "stopped"]);
  assert.ok(data.reads.includes(`/guarantors/link-operations/${operationId}`));
}));

test("S7: Save keeps the loaded child version after its fresh claim-only read", async () => usingFixture(async data => {
  const snapshot = await data.snapshot();
  data.before = (path, method) => {
    if (path === "RelatedPerson/a" && method === "GET" && data.writes.length === 1) { data.before = undefined; data.change("RelatedPerson/a", { name: [{ given: ["Competitor"] }] }); }
  };
  const result = await saveGuarantor(snapshot, destination);
  const write = data.writes.find(item => item.path === "RelatedPerson/a");
  assert.equal(write?.version, 'W/"1"');
  assert.equal(write?.status, 412);
  assert.equal(result.children[0].writeStatus, "conflict");
  assert.deepEqual(data.get<RelatedPerson>("RelatedPerson/a").name, [{ given: ["Competitor"] }]);
}));

test("S7: Save checks each child and reloads pending after a late claim", async () => usingFixture(async data => {
  await usingEditor(data, async renderer => {
    const family = renderer.root.findAllByType("label").find(node => node.children[0] === "Family name 1")!.findByType("input");
    await act(async () => { family.props.onChange({ target: { value: "Edited" } }); });
    data.before = (path, method) => {
      if (path === "RelatedPerson/b" && method === "GET" && data.writes.length === 2) { data.before = undefined; data.claim("b"); }
    };
    await act(async () => { await button(renderer, "Save guarantor")!.props.onClick(); });
    assert.deepEqual(data.writes.map(write => write.path), ["Person/source", "RelatedPerson/a"]);
    assert.equal(button(renderer, "Save guarantor")?.props.disabled, true);
    assert.ok(button(renderer, "Complete"), "a stopped save must reload the pending state");
  });
}));

test("L23 S7: an edit after release is ordinary drift and Repair converges to current D", async () => usingFixture(async data => {
  data.finish();
  data.change("Person/destination", { name: [{ given: ["Newer"], family: "Guardian" }] });
  const load = await loadGuarantor("a");
  assert.equal(load.kind, "editable");
  if (load.kind !== "editable") throw new Error("Expected released child to be editable");
  assert.deepEqual(load.verification.children.map(child => child.classification), ["mismatched", "mismatched"]);
  await usingEditor(data, async renderer => {
    const repair = button(renderer, "Repair for Sam Synthetic, Leo Synthetic");
    assert.ok(repair);
    await act(async () => { await repair.props.onClick(); });
    assert.deepEqual(data.writes.map(write => write.path), ["RelatedPerson/a", "RelatedPerson/b"]);
    for (const id of ["a", "b"]) assert.deepEqual(data.get<RelatedPerson>(`RelatedPerson/${id}`).name, [{ given: ["Newer"], family: "Guardian" }]);
    assert.equal(button(renderer, "Repair for Sam Synthetic, Leo Synthetic"), undefined);
    assert.equal(button(renderer, "Complete"), undefined);
  });
}));

test("S7: Repair stops at a newly claimed matching child before repairing a mismatched sibling", async () => usingFixture(async data => {
  data.change("RelatedPerson/b", destination);
  const snapshot = await data.snapshot();
  data.before = (path, method) => {
    if (path === "Person" && method === "GET") { data.before = undefined; data.claim("a"); }
  };
  const result = await repairGuarantor(snapshot);
  assert.deepEqual(data.writes, [], "a matching child's active claim must prevent the later sibling PUT");
  assert.equal(result.status, "superseded");
  assert.deepEqual(result.children.map(child => child.writeStatus), ["stopped", "stopped"]);
  assert.ok(data.reads.includes(`/guarantors/link-operations/${operationId}`));
  assert.deepEqual(data.get<RelatedPerson>("RelatedPerson/b").name, destination.name);
}));

test("S7: a correction reason survives same-Task refusal and clears when another Task takes over", async () => usingFixture(async data => {
  data.claim("a");
  data.action = () => Response.json({ error: "Correction refused; original remains pending" }, { status: 409 });
  await usingEditor(data, async renderer => {
    const reason = () => renderer.root.findAllByType("label").find(node => node.children[0] === "Reason for correction")!.findByType("input");
    await act(async () => { reason().props.onChange({ target: { value: "Reason for the original operation" } }); });
    await act(async () => { await button(renderer, "Correct")!.props.onClick(); });
    assert.equal(data.writes.length, 1);
    assert.equal(reason().props.value, "Reason for the original operation", "a same-Task refusal must preserve the entered explanation");
    const successorId = `${operationId}-successor`;
    data.operation.task = { ...data.operation.task, id: successorId };
    data.change("RelatedPerson/a", { extension: data.get<RelatedPerson>("RelatedPerson/a").extension!.map(extension => extension.url === claimUrl
      ? { ...extension, valueReference: { reference: `Task/${successorId}` } } : extension) });
    await act(async () => { await button(renderer, "Reload guarantor")!.props.onClick(); });
    assert.match(renderedText(renderer), new RegExp(successorId));
    assert.equal(reason().props.value, "", "a new Task must not inherit the previous operation's explanation");
    assert.equal(button(renderer, "Correct")!.props.disabled, true);
    assert.equal(data.writes.length, 1, "the new operation needs its own entered reason before another request");
  });
}));

test("S7: Correct sends fresh v4 operation IDs when randomUUID is unavailable", async t => usingFixture(async data => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  const randomBytes = t.mock.method(crypto, "getRandomValues", (bytes: Uint8Array) => {
    assert.equal(bytes.byteLength, 16);
    getRandomValues(bytes);
    // Force non-v4 bits so removing either mask cannot pass by chance.
    bytes[6] = 0xff;
    bytes[8] = 0xff;
    return bytes;
  });
  try {
    data.claim("a");
    data.action = () => Response.json({ error: "Correction refused; original remains pending" }, { status: 409 });
    await usingEditor(data, async renderer => {
      const reason = renderer.root.findAllByType("label").find(node => node.children[0] === "Reason for correction")!.findByType("input");
      await act(async () => { reason.props.onChange({ target: { value: "Retain the original guarantor" } }); });
      for (let attempt = 0; attempt < 2; attempt++) {
        await act(async () => { await button(renderer, "Correct")!.props.onClick(); });
      }
      assert.equal(data.writes.length, 2, "each Correct click must send its request without native randomUUID");
      const ids = data.writes.map(write => {
        assert.equal(write.path, `/guarantors/link-operations/${operationId}/correct`);
        assert.equal(write.method, "POST");
        const body = write.body as { operationId: string; reason: string };
        assert.equal(body.reason, "Retain the original guarantor");
        assert.match(body.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        return body.operationId;
      });
      assert.equal(new Set(ids).size, 2, "separate Correct clicks need distinct operation IDs");
      assert.equal(randomBytes.mock.callCount(), 2);
    });
  } finally {
    randomBytes.mock.restore();
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    else Reflect.deleteProperty(crypto, "randomUUID");
  }
}));

test("S7: Correct keeps native randomUUID when available", async t => usingFixture(async data => {
  const nativeId = "499fc7c4-d6fd-468f-a646-695455c934d1";
  const native = t.mock.method(crypto, "randomUUID", () => nativeId);
  t.mock.method(crypto, "getRandomValues", () => { throw new Error("Native randomUUID must remain preferred"); });
  const { correctGuarantorLinkOperation } = await import("../src/lib/guarantor-link-operations");
  await correctGuarantorLinkOperation(operationId, "Use the native operation ID");
  assert.equal(native.mock.callCount(), 1);
  assert.deepEqual(data.writes.map(({ path, method, body }) => ({ path, method, body })), [{
    path: `/guarantors/link-operations/${operationId}/correct`, method: "POST",
    body: { operationId: nativeId, reason: "Use the native operation ID" },
  }]);
}));
