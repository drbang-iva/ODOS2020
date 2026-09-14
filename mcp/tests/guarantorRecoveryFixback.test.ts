import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { RelatedPerson, Task } from "@medplum/fhirtypes";
import { GUARANTOR_CLAIM_URL } from "../src/clinic/guarantor-link-operation.js";
import { fixture, run } from "./guarantorScreensFixture.js";

function journal(task: Task) {
  return JSON.parse(task.extension!.find(extension => extension.url.endsWith("/guarantor-link-journal"))!.valueString!) as {
    intents: { phase: string; disposition?: string }[];
  };
}

function claims(f: ReturnType<typeof fixture>): string[] {
  return (f.get<RelatedPerson>("RelatedPerson/r1").extension ?? [])
    .filter(extension => extension.url === GUARANTOR_CLAIM_URL)
    .map(extension => extension.valueReference!.reference!);
}

test("R7: Complete supersedes a pre-ownership correction after its original was cancelled and a later transfer completed", async t => {
  const f = fixture(1);
  const original = await run(f, "create", f.input());
  assert.equal(original.status, 200);
  const originalId = (original.body as any).task.id as string;

  const corrections = await Promise.all([
    run(f, "correct", { operationId: randomUUID(), reason: "Concurrent correction one" }, originalId),
    run(f, "correct", { operationId: randomUUID(), reason: "Concurrent correction two" }, originalId),
  ]);
  const completed = corrections.find(result => result.status === 200)!;
  const paused = corrections.find(result => result.status === 409)!;
  assert.ok(completed);
  assert.ok(paused);
  assert.equal((paused.body as any).phase, "recovery-conflict");
  const pausedId = (paused.body as any).task.id as string;
  const pausedTask = f.get<Task>(`Task/${pausedId}`);
  assert.equal(pausedTask.status, "in-progress");
  assert.equal(journal(pausedTask).intents.some(intent => intent.disposition === "landed" && ["detaching", "attaching", "projecting", "releasing"].includes(intent.phase)), false);
  assert.equal(f.get<Task>(`Task/${originalId}`).status, "cancelled");
  assert.deepEqual(f.owners("r1"), ["S"]);
  assert.deepEqual(claims(f), []);

  const later = await run(f, "create", f.input());
  assert.equal(later.status, 200);
  assert.deepEqual(f.owners("r1"), ["D"]);
  const offset = f.writes.length;
  const auditOffset = f.audits.length;
  const result = await run(f, "complete", undefined, pausedId);
  const domainWrites = f.writes.slice(offset).filter(write => write.resource.resourceType === "Person" || write.resource.resourceType === "RelatedPerson");
  const pendingAudits = f.audits.slice(auditOffset).filter(audit => audit.eventType === "guarantor.link.pending");
  const finalTask = f.get<Task>(`Task/${pausedId}`);
  t.diagnostic(JSON.stringify({ status: result.status, taskStatus: finalTask.status, businessStatus: finalTask.businessStatus?.text, owners: f.owners("r1"), domainWrites: domainWrites.map(write => `${write.resource.resourceType}/${write.resource.id}:${write.status}`), pendingAudits: pendingAudits.map(audit => audit.actionReason) }));

  assert.equal(result.status, 200);
  assert.equal(finalTask.status, "cancelled");
  assert.equal(finalTask.businessStatus?.text, "superseded");
  assert.deepEqual(domainWrites, []);
  assert.deepEqual(f.owners("r1"), ["D"]);
  assert.equal(pendingAudits.length, 1);
  assert.match(pendingAudits[0].actionReason, new RegExp(`target=Task/${originalId}(?:;| )`));
});

test("R8: Complete fails a pre-ownership correction when its completed original no longer owns the child", async t => {
  const f = fixture(1);
  const original = await run(f, "create", f.input());
  assert.equal(original.status, 200);
  const originalId = (original.body as any).task.id as string;
  let raced = false;
  f.beforeWrite = async write => {
    if (raced || (write.actor as any).actionReason !== "guarantor.link fence-source Person/D") return;
    raced = true;
    f.compete("Person/D", person => person, f.deps.serviceReference);
  };
  const correction = await run(f, "correct", { operationId: randomUUID(), reason: "Pause before any ownership write" }, originalId);
  f.beforeWrite = undefined;
  assert.equal(raced, true);
  assert.equal(correction.status, 409);
  assert.equal((correction.body as any).phase, "recovery-conflict");
  const correctionId = (correction.body as any).task.id as string;
  assert.equal(journal(f.get<Task>(`Task/${correctionId}`)).intents.some(intent => intent.disposition === "landed" && ["detaching", "attaching", "projecting", "releasing"].includes(intent.phase)), false);
  assert.equal(f.get<Task>(`Task/${originalId}`).status, "completed");

  f.compete("Person/D", person => ({ ...person, link: (person.link ?? []).filter(link => link.target.reference !== "RelatedPerson/r1") }), f.deps.serviceReference);
  f.compete("Person/S", person => ({ ...person, active: true, link: [...person.link ?? [], { target: { reference: "RelatedPerson/r1" }, assurance: "level2" }] }), f.deps.serviceReference);
  assert.deepEqual(f.owners("r1"), ["S"]);
  const offset = f.writes.length;
  const result = await run(f, "complete", undefined, correctionId);
  const domainWrites = f.writes.slice(offset).filter(write => /guarantor\.link (?:claiming|detaching|attaching|projecting|releasing)\b/.test((write.actor as any).actionReason));
  const finalTask = f.get<Task>(`Task/${correctionId}`);
  t.diagnostic(JSON.stringify({ status: result.status, phase: (result.body as any).phase, taskStatus: finalTask.status, businessStatus: finalTask.businessStatus?.text, owners: f.owners("r1"), domainWrites: domainWrites.map(write => (write.actor as any).actionReason) }));

  assert.equal(result.status, 409);
  assert.equal((result.body as any).phase, "correction-conflict");
  assert.equal(finalTask.status, "failed");
  assert.equal(finalTask.businessStatus?.text, "correction-conflict");
  assert.deepEqual(domainWrites, []);
  assert.deepEqual(f.owners("r1"), ["S"]);
});
