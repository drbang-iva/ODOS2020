import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Person, RelatedPerson, Resource, Task } from "@medplum/fhirtypes";
import * as engine from "../src/clinic/guarantor-link-operation.js";
import { GUARANTOR_CLAIM_URL, GUARANTOR_EPOCH_URL } from "../src/clinic/guarantor-link-operation.js";
import { fixture, run } from "./guarantorScreensFixture.js";

type Fixture = ReturnType<typeof fixture>;
type Intent = { phase: string; target: string; expectedVersion: string; intendedContentHash: string; ownedHash?: string; disposition?: string };
function intents(f: Fixture, id: string): Intent[] {
  const task = f.get<Task>(`Task/${id}`);
  return JSON.parse(task.extension!.find(e => e.url.endsWith("/guarantor-link-journal"))!.valueString!).intents;
}
function claims(f: Fixture): string[] {
  return (f.get<RelatedPerson>("RelatedPerson/r1").extension ?? []).filter(e => e.url === GUARANTOR_CLAIM_URL).map(e => e.valueReference!.reference!);
}
async function lostCorrection(phase: "detaching" | "releasing") {
  const f = fixture(1);
  const original = await run(f, "create", f.input());
  assert.equal(original.status, 200);
  const originalId = (original.body as any).task.id as string;
  assert.equal(f.get<Task>(`Task/${originalId}`).status, "completed");
  let losses = 0;
  f.afterWrite = async write => {
    const target = phase === "detaching" ? "Person/D" : "RelatedPerson/r1";
    if ((write.actor as any).actionReason !== `guarantor.link ${phase} ${target}` || losses) return;
    assert.equal(write.status, 200, "reply loss follows a committed write");
    losses++;
    throw new Error("reply lost");
  };
  const correction = await run(f, "correct", { operationId: randomUUID(), reason: "Synthetic correction" }, originalId);
  f.afterWrite = undefined;
  assert.equal(losses, 1);
  assert.equal(correction.status, 409);
  assert.equal((correction.body as any).phase, "recovery-conflict");
  const correctionId = (correction.body as any).task.id as string;
  const unresolved = intents(f, correctionId).filter(i => !i.disposition);
  assert.equal(unresolved.length, 1, "the committed write has an unresolved intent");
  assert.equal(unresolved[0].phase, phase);
  return { f, originalId, correctionId };
}

test("R1 X1: lost correction detach followed by a staff rename completes with source ownership and no claim", async t => {
  const { f, correctionId } = await lostCorrection("detaching");
  assert.deepEqual(f.owners("r1"), []);
  assert.deepEqual(claims(f), [`Task/${correctionId}`]);
  f.compete("Person/D", person => ({ ...person, name: [{ family: "Staff renamed destination" }] }));
  const completed = await run(f, "complete", undefined, correctionId);
  const repeated = completed.status === 200 ? undefined : await run(f, "complete", undefined, correctionId);
  const correctAgain = await run(f, "correct", { operationId: randomUUID(), reason: "Synthetic nested correction" }, correctionId);
  t.diagnostic(JSON.stringify({ schedule: "X1", complete: [completed, repeated].filter(Boolean).map((r: any) => ({ status: r.status, phase: r.body.phase })), correct: correctAgain.status, owners: f.owners("r1"), claims: claims(f), correctionStatus: f.get<Task>(`Task/${correctionId}`).status }));
  assert.equal(completed.status, 200);
  assert.equal(f.get<Task>(`Task/${correctionId}`).status, "completed");
  assert.deepEqual(f.owners("r1"), ["S"]);
  assert.deepEqual(claims(f), []);
  assert.equal(correctAgain.status, 422);
});

test("R2 X2: lost correction release followed by transfer B completes without rewriting B's child", async t => {
  const { f, originalId, correctionId } = await lostCorrection("releasing");
  assert.deepEqual(f.owners("r1"), ["S"]);
  assert.deepEqual(claims(f), []);
  const later = await run(f, "create", f.input());
  assert.equal(later.status, 200);
  assert.equal((later.body as any).task.status, "completed");
  assert.deepEqual(f.owners("r1"), ["D"]);
  const childAfterB = f.get<RelatedPerson>("RelatedPerson/r1");
  const offset = f.writes.length;
  const completed = await run(f, "complete", undefined, correctionId);
  const repeated = completed.status === 200 ? undefined : await run(f, "complete", undefined, correctionId);
  const correctAgain = await run(f, "correct", { operationId: randomUUID(), reason: "Synthetic nested correction" }, correctionId);
  t.diagnostic(JSON.stringify({ schedule: "X2", complete: [completed, repeated].filter(Boolean).map((r: any) => ({ status: r.status, phase: r.body.phase })), correct: correctAgain.status, owners: f.owners("r1"), claims: claims(f), correctionStatus: f.get<Task>(`Task/${correctionId}`).status, originalStatus: f.get<Task>(`Task/${originalId}`).status }));
  assert.equal(completed.status, 200);
  assert.equal(f.get<Task>(`Task/${correctionId}`).status, "completed");
  assert.equal(f.get<Task>(`Task/${originalId}`).status, "cancelled");
  assert.deepEqual(f.owners("r1"), ["D"]);
  assert.deepEqual(claims(f), []);
  assert.deepEqual(f.get<RelatedPerson>("RelatedPerson/r1"), childAfterB);
  assert.equal(f.writes.slice(offset).filter(w => w.resource.resourceType === "RelatedPerson" && w.resource.id === "r1").length, 0);
  assert.equal(correctAgain.status, 422);
});

test("R3: a service competitor changing an unresolved Person link intent remains interfered", async () => {
  const { f, correctionId } = await lostCorrection("detaching");
  f.compete("Person/D", person => ({ ...person, link: [] }), f.deps.serviceReference);
  const offset = f.writes.length;
  const result = await run(f, "complete", undefined, correctionId);
  assert.equal(result.status, 409);
  assert.equal((result.body as any).phase, "interfered");
  assert.deepEqual(f.owners("r1"), []);
  assert.deepEqual(claims(f), [`Task/${correctionId}`]);
  assert.equal(f.writes.slice(offset).filter(w => w.status === 200 && w.resource.resourceType !== "Task").length, 0);
});

test("R4: an old journal without ownedHash retains full-content interference after a staff rename", async () => {
  const { f, correctionId } = await lostCorrection("detaching");
  const task = f.get<Task>(`Task/${correctionId}`);
  const extension = task.extension!.find(e => e.url.endsWith("/guarantor-link-journal"))!;
  const journal = JSON.parse(extension.valueString!);
  journal.intents = journal.intents.map(({ ownedHash: _ownedHash, ...legacy }: Intent) => legacy);
  extension.valueString = JSON.stringify(journal);
  f.seed(task);
  assert.ok(intents(f, correctionId).every(i => i.ownedHash === undefined && i.intendedContentHash.length === 64));
  f.compete("Person/D", person => ({ ...person, name: [{ family: "Staff renamed destination" }] }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run(f, "complete", undefined, correctionId);
    assert.equal(result.status, 409);
    assert.equal((result.body as any).phase, "interfered");
  }
  assert.equal(f.get<Task>(`Task/${correctionId}`).status, "in-progress");
  assert.deepEqual(f.owners("r1"), []);
  assert.deepEqual(claims(f), [`Task/${correctionId}`]);
});

test("R5: each phase hashes its owned fields and ignores non-owned changes", () => {
  const hash = (engine as typeof engine & { guarantorOwnedHash(resource: Resource, phase: string): string }).guarantorOwnedHash;
  assert.equal(typeof hash, "function");
  const person: Person = { resourceType: "Person", id: "projection", active: true,
    name: [{ family: "Source" }], telecom: [{ system: "phone", value: "202-555-0100" }], address: [{ city: "Source town" }],
    link: [{ target: { reference: "RelatedPerson/r1" }, assurance: "level2" }, { target: { reference: "RelatedPerson/r2" } }],
    extension: [{ url: GUARANTOR_EPOCH_URL, valueString: "epoch-one" }] };
  const child: RelatedPerson = { resourceType: "RelatedPerson", id: "r1", patient: { reference: "Patient/p1" }, active: true,
    name: person.name, telecom: person.telecom, address: person.address,
    extension: [{ url: GUARANTOR_CLAIM_URL, valueReference: { reference: "Task/one" } }, { url: GUARANTOR_CLAIM_URL, valueReference: { reference: "Task/two" } }] };
  const unchanged = structuredClone([person, child]);
  for (const phase of ["fence-source", "fence-destination"]) {
    assert.equal(hash(person, phase), hash({ ...person, active: false, link: [], name: [{ family: "Changed" }] }, phase), phase);
    assert.notEqual(hash(person, phase), hash({ ...person, extension: [{ url: GUARANTOR_EPOCH_URL, valueString: "epoch-two" }] }, phase), `${phase}: epoch`);
  }
  for (const phase of ["detaching", "attaching"]) {
    assert.equal(hash(person, phase), hash({ ...person, name: [{ family: "Changed" }], telecom: [], address: [], extension: [], meta: { versionId: "999" } }, phase), phase);
    assert.notEqual(hash(person, phase), hash({ ...person, link: person.link!.slice(1) }, phase), `${phase}: link`);
    assert.notEqual(hash(person, phase), hash({ ...person, active: false }, phase), `${phase}: active`);
    assert.equal(hash(person, phase), hash({ ...person, link: [...person.link!].reverse().map(link => ({ ...link, assurance: "level4" })) }, phase), `${phase}: targets are a set`);
    assert.equal(hash(person, phase), hash({ ...person, link: [...person.link!, person.link![0]] }, phase), `${phase}: repeated target`);
  }
  for (const phase of ["claiming", "releasing"]) {
    assert.equal(hash(child, phase), hash({ ...child, active: false, name: [], telecom: [], address: [] }, phase), phase);
    assert.notEqual(hash(child, phase), hash({ ...child, extension: [] }, phase), `${phase}: claims`);
    assert.equal(hash(child, phase), hash({ ...child, extension: [...child.extension!].reverse() }, phase), `${phase}: claim order`);
    assert.equal(hash(child, phase), hash({ ...child, extension: [...child.extension!, child.extension![0]] }, phase), `${phase}: repeated claim`);
  }
  assert.equal(hash(child, "projecting"), hash({ ...child, active: false, patient: { reference: "Patient/other" }, relationship: [{ text: "Changed" }] }, "projecting"));
  for (const change of [{ extension: [] }, { name: [{ family: "Changed" }] }, { telecom: [{ system: "phone" as const, value: "202-555-0199" }] }, { address: [{ city: "Changed" }] }]) {
    assert.notEqual(hash(child, "projecting"), hash({ ...child, ...change }, "projecting"), `projecting: ${Object.keys(change)[0]}`);
  }
  for (const resource of [person, child]) {
    assert.equal(hash(resource, "unrecognized-phase"), engine.guarantorContentHash(resource));
    assert.notEqual(hash(resource, "unrecognized-phase"), hash({ ...resource, active: false }, "unrecognized-phase"));
  }
  assert.deepEqual([person, child], unchanged);
});

async function correctionBeforeDetach(originalPending = false) {
  const f = fixture(1);
  if (originalPending) f.afterWrite = async write => {
    if ((write.actor as any).actionReason === "guarantor.link projecting RelatedPerson/r1") throw new Error("reply lost");
  };
  const original = await run(f, "create", f.input());
  assert.equal(original.status, originalPending ? 409 : 200);
  const originalId = (original.body as any).task.id as string;
  const correctionInput = { operationId: randomUUID(), reason: "Synthetic correction paused before detach" };
  f.afterWrite = async write => {
    if ((write.actor as any).actionReason === "guarantor.link claiming RelatedPerson/r1") throw new Error("reply lost");
  };
  const correction = await run(f, "correct", correctionInput, originalId);
  f.afterWrite = undefined;
  assert.equal(correction.status, 409);
  assert.equal((correction.body as any).phase, "claim-pending");
  const correctionId = (correction.body as any).task.id as string;
  assert.deepEqual(f.owners("r1"), ["D"]);
  assert.deepEqual(claims(f), [`Task/${correctionId}`]);
  return { f, originalId, correctionId, correctionInput };
}

for (const originalPending of [false, true]) test(`R6: second Undo of ${originalPending ? "pending" : "completed"} original refuses without a write or a Task`, async t => {
  const { f, originalId, correctionId, correctionInput } = await correctionBeforeDetach(originalPending);
  const offset = f.writes.length;
  const taskIds = [...f.data.keys()].filter(key => key.startsWith("Task/"));
  const repeated = await run(f, "correct", correctionInput, originalId);
  assert.equal(repeated.status, 200);
  assert.equal((repeated.body as any).task.id, correctionId);
  const result = await run(f, "correct", { operationId: randomUUID(), reason: "Second Undo" }, originalId);
  t.diagnostic(JSON.stringify({ status: result.status, phase: (result.body as any).phase, writes: f.writes.length - offset, newTasks: [...f.data.keys()].filter(key => key.startsWith("Task/") && !taskIds.includes(key)) }));
  assert.equal(result.status, 409);
  assert.equal((result.body as any).error, "A correction of this operation is already in progress.");
  assert.equal(f.writes.length, offset);
  assert.deepEqual([...f.data.keys()].filter(key => key.startsWith("Task/")), taskIds);
  const history = await run(f, "history", { relatedPersonId: "r1" });
  assert.equal(history.status, 200);
  assert.equal((history.body as any[]).find(row => row.task.id === originalId).correctionInProgress, true);
});

for (const state of ["untrusted", "failed", "cancelled"] as const) test(`R6: a ${state} correction does not block a new Undo`, async () => {
  const { f, originalId, correctionId } = await correctionBeforeDetach();
  f.compete(`Task/${correctionId}`, task => ({ ...task, ...(state === "untrusted" ? {} : { status: state }) }), state === "untrusted" ? "Practitioner/untrusted" : f.deps.serviceReference);
  const history = await run(f, "history", { relatedPersonId: "r1" });
  assert.equal((history.body as any[]).find(row => row.task.id === originalId).correctionInProgress, false);
  const result = await run(f, "correct", { operationId: randomUUID(), reason: "New Undo after inert correction" }, originalId);
  assert.equal(result.status, 200);
  assert.equal((result.body as any).task.status, "completed");
  assert.deepEqual(f.owners("r1"), ["S"]);
});
