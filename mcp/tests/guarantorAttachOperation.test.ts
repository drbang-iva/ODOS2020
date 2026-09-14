import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Extension, Person, RelatedPerson, Resource, Task } from "@medplum/fhirtypes";
import { GUARANTOR_CLAIM_URL } from "../src/clinic/guarantor-link-operation.js";
import { fixture, run } from "./guarantorScreensFixture.js";

type Fixture = ReturnType<typeof fixture>;
type Result = Awaited<ReturnType<typeof run>>;

function unownedFixture(): Fixture {
  const f = fixture(1);
  f.compete("Person/S", person => ({ ...person, active: false, link: [] }));
  return f;
}

function attachInput(f: Fixture, destinationPersonId = "D") {
  return {
    operationId: randomUUID(),
    kind: "attach",
    destinationPersonId,
    relatedPersonIds: ["r1"],
    expected: {
      [`Person/${destinationPersonId}`]: f.get<Person>(`Person/${destinationPersonId}`).meta!.versionId!,
      "RelatedPerson/r1": f.get<RelatedPerson>("RelatedPerson/r1").meta!.versionId!,
    },
    reason: "Synthetic staff-approved attach",
  };
}

function claims(f: Fixture): string[] {
  return (f.get<RelatedPerson>("RelatedPerson/r1").extension ?? [])
    .filter(extension => extension.url === GUARANTOR_CLAIM_URL)
    .map(extension => extension.valueReference!.reference!);
}

function phase(write: Fixture["writes"][number]): string {
  return (write.actor as { actionReason: string }).actionReason.split(" ")[1] ?? "";
}

function withoutMetaAndClaim(resource: RelatedPerson): Omit<RelatedPerson, "meta"> {
  const { meta: _meta, ...body } = resource;
  const extension = body.extension?.filter(item => item.url !== GUARANTOR_CLAIM_URL);
  return { ...body, extension: extension?.length ? extension : undefined };
}

function taskFrom(result: Result): Task {
  return (result.body as { task: Task }).task;
}

test("A1: two concurrent chart attaches admit one winner and fail the loser at the claim before its Person write", { timeout: 5000 }, async () => {
  const f = unownedFixture();
  f.seed<Person>({ ...f.D, id: "D2", link: [] });
  const firstInput = attachInput(f, "D");
  const secondInput = attachInput(f, "D2");
  let releaseRecords!: () => void;
  const bothRecorded = new Promise<void>(resolve => { releaseRecords = resolve; });
  let recordCount = 0;
  f.beforeWrite = async write => {
    if (write.resource.resourceType === "Task" && !write.resource.id) {
      recordCount += 1;
      if (recordCount === 2) releaseRecords();
      else await bothRecorded;
    }
  };

  const [first, second] = await Promise.all([run(f, "create", firstInput), run(f, "create", secondInput)]);
  f.beforeWrite = undefined;

  const results = [first, second];
  assert.equal(f.writes.filter(write => write.resource.resourceType === "Person" && phase(write) === "attaching").length, 1, "the losing attach never reaches a Person PUT");
  assert.equal(results.filter(result => taskFrom(result).status === "completed").length, 1);
  const loser = results.find(result => taskFrom(result).status === "failed")!;
  assert.equal((loser.body as { phase: string }).phase, "claim-conflict");
  assert.equal(f.owners("r1").length, 1);
}
);

test("A2: attach refuses an already-owned RelatedPerson before recording a Task", async () => {
  const f = fixture(1);
  f.seed<Person>({ ...f.D, id: "D2", link: [] });
  const result = await run(f, "create", attachInput(f, "D2"));
  assert.equal(result.status, 409);
  assert.equal(f.writes.length, 0);
  assert.equal([...f.data.keys()].filter(key => key.startsWith("Task/")).length, 0);
});

test("A3: a destination edit after validation pauses attach, and Complete fences only that destination", async () => {
  const f = unownedFixture();
  let changed = false;
  f.afterWrite = async write => {
    if (!changed && write.resource.resourceType === "RelatedPerson" && phase(write) === "claiming") {
      changed = true;
      f.compete("Person/D", person => ({ ...person, name: [{ family: "Staff edited destination" }] }));
    }
  };
  const started = await run(f, "create", attachInput(f));
  f.afterWrite = undefined;
  assert.equal(started.status, 409);
  assert.equal((started.body as { phase: string }).phase, "attach-pending");
  const offset = f.writes.length;
  const completed = await run(f, "complete", undefined, taskFrom(started).id);
  assert.equal(completed.status, 200);
  assert.equal(taskFrom(completed).status, "completed");
  assert.deepEqual(f.owners("r1"), ["D"]);
  assert.equal(f.writes.slice(offset).some(write => write.resource.resourceType === "Person" && write.resource.id === "S"), false);
});

test("A4: Complete classifies a landed attach after reply loss without a second attaching PUT", async () => {
  const f = unownedFixture();
  let lost = false;
  f.afterWrite = async write => {
    if (!lost && write.resource.resourceType === "Person" && write.resource.id === "D" && phase(write) === "attaching") {
      lost = true;
      assert.equal(write.status, 200);
      throw new Error("synthetic reply loss after committed attach");
    }
  };
  const started = await run(f, "create", attachInput(f));
  f.afterWrite = undefined;
  assert.equal(started.status, 409);
  assert.equal((started.body as { phase: string }).phase, "attach-pending");
  assert.deepEqual(f.owners("r1"), ["D"]);
  const completed = await run(f, "complete", undefined, taskFrom(started).id);
  assert.equal(completed.status, 200);
  assert.equal(taskFrom(completed).status, "completed");
  assert.equal(f.writes.filter(write => write.resource.resourceType === "Person" && write.resource.id === "D" && phase(write) === "attaching").length, 1);
});

test("A5/A15: correcting a completed attach unlinks without projection and preserves every child-owned field", async () => {
  const f = unownedFixture();
  const attached = await run(f, "create", attachInput(f));
  assert.equal(attached.status, 200);
  const beforeUnlink = f.get<RelatedPerson>("RelatedPerson/r1");
  const sibling = f.get<RelatedPerson>("RelatedPerson/k");
  const offset = f.writes.length;
  const unlinked = await run(f, "correct", { operationId: randomUUID(), reason: "Synthetic unlink" }, taskFrom(attached).id);
  assert.equal(unlinked.status, 200);
  assert.equal(taskFrom(unlinked).status, "completed");
  assert.deepEqual(f.owners("r1"), []);
  assert.deepEqual(claims(f), []);
  assert.deepEqual(f.get<RelatedPerson>("RelatedPerson/k"), sibling);
  assert.deepEqual(withoutMetaAndClaim(f.get<RelatedPerson>("RelatedPerson/r1")), withoutMetaAndClaim(beforeUnlink));
  assert.equal(f.writes.slice(offset).some(write => write.resource.resourceType === "RelatedPerson" && phase(write) === "projecting"), false);
  assert.deepEqual(f.get<Person>("Person/D").link?.map(link => link.target.reference), ["RelatedPerson/k"]);
});

async function attachWithLostReply(phaseName: "attaching" | "releasing" | "detaching") {
  const f = unownedFixture();
  let lost = false;
  f.afterWrite = async write => {
    const targetType = phaseName === "releasing" ? "RelatedPerson" : "Person";
    if (!lost && write.resource.resourceType === targetType && phase(write) === phaseName) {
      lost = true;
      assert.equal(write.status, 200);
      throw new Error(`synthetic reply loss after ${phaseName}`);
    }
  };
  const result = await run(f, "create", attachInput(f));
  f.afterWrite = undefined;
  assert.equal(lost, phaseName === "attaching");
  return { f, result };
}

test("A6: unlink takes over a pending attach whose Person write landed", async () => {
  const { f, result: pending } = await attachWithLostReply("attaching");
  assert.equal(pending.status, 409);
  assert.deepEqual(f.owners("r1"), ["D"]);
  const unlinked = await run(f, "correct", { operationId: randomUUID(), reason: "Undo landed pending attach" }, taskFrom(pending).id);
  assert.equal(unlinked.status, 200);
  assert.equal(taskFrom(unlinked).status, "completed");
  assert.equal(f.get<Task>(`Task/${taskFrom(pending).id}`).status, "cancelled");
  assert.deepEqual(f.owners("r1"), []);
  assert.deepEqual(claims(f), []);
});

test("A7: unlink of a pending attach before the attach lands performs no detaching Person PUT", async () => {
  const f = unownedFixture();
  let changed = false;
  f.beforeWrite = async write => {
    if (!changed && write.resource.resourceType === "Person" && write.resource.id === "D" && phase(write) === "attaching") {
      changed = true;
      f.compete("Person/D", person => ({ ...person, name: [{ family: "Concurrent edit before attach" }] }));
    }
  };
  const pending = await run(f, "create", attachInput(f));
  f.beforeWrite = undefined;
  assert.equal(pending.status, 409);
  assert.equal((pending.body as { phase: string }).phase, "attach-pending");
  assert.deepEqual(f.owners("r1"), []);
  const offset = f.writes.length;
  const unlinked = await run(f, "correct", { operationId: randomUUID(), reason: "Undo unlanded attach" }, taskFrom(pending).id);
  assert.equal(unlinked.status, 200);
  assert.equal(taskFrom(unlinked).status, "completed");
  assert.equal(f.writes.slice(offset).some(write => write.resource.resourceType === "Person" && phase(write) === "detaching"), false);
});

test("A8: correcting an unlink is refused without a Task", async () => {
  const f = unownedFixture();
  const attached = await run(f, "create", attachInput(f));
  const unlinked = await run(f, "correct", { operationId: randomUUID(), reason: "First undo" }, taskFrom(attached).id);
  const offset = f.writes.length;
  const refused = await run(f, "correct", { operationId: randomUUID(), reason: "Nested undo" }, taskFrom(unlinked).id);
  assert.equal(refused.status, 422);
  assert.equal(f.writes.length, offset);
});

test("A16: lost unlink release cannot overwrite a later completed attach", async () => {
  const f = unownedFixture();
  f.seed<Person>({ ...f.D, id: "D2", link: [] });
  const attached = await run(f, "create", attachInput(f));
  let lost = false;
  f.afterWrite = async write => {
    if (!lost && write.resource.resourceType === "RelatedPerson" && phase(write) === "releasing") {
      lost = true;
      assert.equal(write.status, 200);
      throw new Error("synthetic unlink release reply loss");
    }
  };
  const unlink = await run(f, "correct", { operationId: randomUUID(), reason: "Unlink with lost release" }, taskFrom(attached).id);
  f.afterWrite = undefined;
  assert.equal(unlink.status, 409);
  assert.deepEqual(f.owners("r1"), []);
  assert.deepEqual(claims(f), []);
  f.compete("RelatedPerson/r1", child => ({ ...child, extension: [...child.extension ?? [], { url: "urn:synthetic:staff-note", valueString: "preserve" }] }));
  const later = await run(f, "create", attachInput(f, "D2"));
  assert.equal(taskFrom(later).status, "completed");
  const childAfterLaterAttach = f.get<RelatedPerson>("RelatedPerson/r1");
  const offset = f.writes.length;
  const completed = await run(f, "complete", undefined, taskFrom(unlink).id);
  assert.equal(completed.status, 200);
  assert.equal(taskFrom(completed).status, "completed");
  assert.equal(f.get<Task>(`Task/${taskFrom(attached).id}`).status, "cancelled");
  assert.deepEqual(f.owners("r1"), ["D2"]);
  assert.deepEqual(f.get<RelatedPerson>("RelatedPerson/r1"), childAfterLaterAttach);
  assert.equal(f.writes.slice(offset).some(write => write.resource.resourceType === "RelatedPerson" && write.resource.id === "r1"), false);
});

test("A17: lost unlink detach plus a staff rename completes, then a later attach remains live", async () => {
  const f = unownedFixture();
  f.seed<Person>({ ...f.D, id: "D2", link: [] });
  const attached = await run(f, "create", attachInput(f));
  let lost = false;
  f.afterWrite = async write => {
    if (!lost && write.resource.resourceType === "Person" && write.resource.id === "D" && phase(write) === "detaching") {
      lost = true;
      assert.equal(write.status, 200);
      throw new Error("synthetic unlink detach reply loss");
    }
  };
  const unlink = await run(f, "correct", { operationId: randomUUID(), reason: "Unlink with lost detach" }, taskFrom(attached).id);
  f.afterWrite = undefined;
  assert.equal(unlink.status, 409);
  assert.deepEqual(f.owners("r1"), []);
  f.compete("Person/D", person => ({ ...person, name: [{ family: "Staff rename survives" }] }));
  const completed = await run(f, "complete", undefined, taskFrom(unlink).id);
  assert.equal(completed.status, 200);
  assert.equal(f.get<Person>("Person/D").name?.[0]?.family, "Staff rename survives");
  assert.deepEqual(f.owners("r1"), []);
  assert.deepEqual(claims(f), []);
  const later = await run(f, "create", attachInput(f, "D2"));
  assert.equal(later.status, 200);
  assert.deepEqual(f.owners("r1"), ["D2"]);
});

test("A18: only attach and correct-of-attach may omit their designated endpoints", async () => {
  const f = unownedFixture();
  const attach = attachInput(f);
  assert.equal((await run(f, "create", attach)).status, 200, "attach without source is accepted");

  const fresh = unownedFixture();
  assert.equal((await run(fresh, "create", { ...attachInput(fresh), sourcePersonId: "S" })).status, 422, "attach with source is refused");
  for (const kind of ["transfer", "consolidate"] as const) {
    const transferFixture = fixture(1);
    const full = transferFixture.input(kind);
    const { sourcePersonId: _source, ...withoutSource } = full;
    assert.equal((await run(transferFixture, "create", withoutSource)).status, 422, `${kind} without source is refused`);
  }

  const transferFixture = fixture(1);
  const original = await run(transferFixture, "create", transferFixture.input());
  const originalTask = transferFixture.get<Task>(`Task/${taskFrom(original).id}`);
  const malformed: Task = {
    ...originalTask,
    id: "malformed-correct-of-transfer",
    status: "completed",
    code: originalTask.code,
    basedOn: [{ reference: `Task/${originalTask.id}` }],
    input: [
      ...(originalTask.input ?? []).filter(input => input.type.text !== "destination" && input.type.text !== "kind"),
      { type: { text: "kind" }, valueCode: "correct" },
    ],
  };
  transferFixture.seed(malformed);
  assert.equal((await run(transferFixture, "status", undefined, malformed.id)).status, 422, "correct-of-transfer without destination is refused");
});
