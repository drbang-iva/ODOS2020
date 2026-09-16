import assert from "node:assert/strict";
import { test } from "node:test";
import type { Condition, Observation, Provenance } from "@medplum/fhirtypes";
import { executeFindingCommand, type FindingCommand } from "../src/clinical-graph/current-finding-writer.js";
import { currentFindingIdentifier, parseCurrentFindingEnvelope, parseFindingOperation, SUPPORTS_DIAGNOSIS_URL } from "../src/clinical-graph/current-finding-identity.js";
import { projectCurrentFindings } from "../src/clinical-graph/current-finding-reader.js";
import { buildEncounterDiagnosisCondition } from "../src/fhir/condition.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../src/clinical-graph/diagnosis-pick-endpoint.js";
import { DIAGNOSIS_FINDING_REASSERTION_CODE } from "../src/clinical-graph/diagnosis-carry-provenance.js";
import { atomic, snapshot, state, nuclear, lensField, comp, definitions } from "./fixtures/r10/factories.js";
import { canonicalFact, command, endState, factBaseline, factTarget, httpError, keyFor, memoryFhir, writerContext } from "./fixtures/r10/writer-harness.js";

const run = (m: ReturnType<typeof memoryFhir>, c: ReturnType<typeof command>) => executeFindingCommand(writerContext(m), c as FindingCommand);
const observations = (m: ReturnType<typeof memoryFhir>) => m.all<Observation>("Observation");
const audits = (m: ReturnType<typeof memoryFhir>) => m.all<Provenance>("Provenance");
const observationWrites = (m: ReturnType<typeof memoryFhir>) => m.writes.filter(w => w.resource.resourceType === "Observation");
const projection = (m: ReturnType<typeof memoryFhir>) => projectCurrentFindings(state(observations(m), { conditions: m.all<Condition>("Condition") }));
const home = (reference: string): Condition => ({ resourceType: "Condition", id: reference.slice(10), meta: { versionId: "c1" }, subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" } });

test("W11 absent create persists one strict canonical owner, separate operation marker, and self-targeted audit", async () => {
  const m = memoryFhir(); const c = command([factTarget()]);
  const result = await run(m, c);
  assert.equal(result.complete, true); assert.equal(result.outcomes[0].status, "applied");
  const o = observations(m)[0];
  assert.equal(observations(m).length, 1); assert.equal(parseCurrentFindingEnvelope(o).status, "valid");
  assert.equal(projection(m).unresolved.length, 0); assert.equal(projection(m).currentFacts.length, 1);
  assert.equal(parseFindingOperation(o)?.commandId, c.commandId);
  assert.deepEqual(audits(m)[0].target?.map(t => t.reference).sort(), [`Observation/${o.id}`, "Patient/p1"].sort());
  assert.equal(observationWrites(m)[0].headers["If-None-Exist"], `identifier=${currentFindingIdentifier(keyFor()).system}|${currentFindingIdentifier(keyFor()).value}`);
});

test("adoption converts legacy GRADE, copies displayed homes, and keeps the resource id", async () => {
  const original = { ...atomic(), component: [comp("GRADE", "2+")] };
  const condition = { ...home("Condition/evidence"), evidence: [{ detail: [{ reference: "Observation/atomic" }] }] };
  const m = memoryFhir([original, condition]); const fact = projection(m).currentFacts[0];
  const result = await run(m, command([factTarget(fact.key, fact.baseline, endState({ qualifiers: fact.qualifiers, homes: fact.homes }))]));
  assert.equal(result.complete, true); assert.equal(observations(m)[0].id, "atomic");
  assert.equal(observationWrites(m)[0].headers["If-Match"], 'W/"v1"');
  assert.equal(observations(m)[0].component?.some(c => c.code.coding?.some(v => v.code === "GRADE")), false);
  assert.deepEqual(projection(m).currentFacts[0].qualifiers, { grade: "2+" });
  assert.equal(observations(m)[0].component?.find(c => c.code.coding?.some(v => v.code === `${lensField}::nuclear-sclerosis::grade`))?.valueCodeableConcept?.coding?.[0].code, "2+");
  assert.deepEqual(projection(m).currentFacts[0].homes, ["Condition/evidence"]);
});

test("W5 materializes only one option, preserving source and sibling, and copies an inferred home", async () => {
  const source = snapshot("snapshot", ["nuclear-sclerosis", "cortical-cataract"]);
  const condition = { ...buildEncounterDiagnosisCondition({ patientReference: "Patient/p1", encounterReference: "Encounter/e1", code: { text: "Synthetic" }, verificationStatus: "confirmed",
    identifiers: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: `e1::${nuclear.diagnosisKeys[0]}::bilateral` }] }), id: "inferred", meta: { versionId: "c1" } };
  const m = memoryFhir([source, condition]); const fact = projection(m).currentFacts.find(f => f.key.optionCode === nuclear.optionCode)!;
  assert.deepEqual(fact.homes, ["Condition/inferred"]);
  const result = await run(m, command([factTarget(fact.key, fact.baseline, endState({ homes: fact.homes, qualifiers: { grade: "3+" } }))]));
  assert.equal(result.complete, true); assert.equal(observations(m).length, 2);
  assert.deepEqual(m.resources.get("Observation/snapshot"), source);
  assert.equal(observations(m).filter(o => o.identifier?.some(i => i.value === currentFindingIdentifier(keyFor("OD", "cortical-cataract")).value)).length, 0);
  assert.deepEqual(projection(m).currentFacts.find(f => f.key.optionCode === nuclear.optionCode)?.homes, ["Condition/inferred"]);
  assert.equal(projection(m).currentFacts.find(f => f.key.optionCode === "cortical-cataract")?.contributors[0].reference, "Observation/snapshot");
});

test("W6 a bare snapshot locator is refused when the addressed key and end state are otherwise valid", async () => {
  const m = memoryFhir([snapshot()]);
  const result = await run(m, command([factTarget(keyFor(), { kind: "legacy", sourceReference: "Observation/snapshot", versionId: "v1" })]));
  assert.equal(result.outcomes[0].status, "refused"); assert.equal(m.writes.length, 0);
});

test("clear then revive keeps one canonical id; an unchanged current state writes nothing", async () => {
  const m = memoryFhir([canonicalFact()]);
  const unchanged = await run(m, command([factTarget(keyFor(), factBaseline(observations(m)))]));
  assert.equal(unchanged.outcomes[0].status, "unchanged"); assert.equal(m.writes.length, 0);
  await run(m, command([factTarget(keyFor(), factBaseline(observations(m)), endState({ status: "retired" }))]));
  assert.equal(observations(m)[0].status, "entered-in-error");
  await run(m, command([factTarget(keyFor(), factBaseline(observations(m)))]));
  assert.equal(observations(m)[0].status, "preliminary"); assert.equal(observations(m)[0].id, "canonical");
  assert.equal(observations(m).length, 1);
});

test("W21 reassert writes only its activity-discriminated audit and resolves replay after a lost audit response", async () => {
  const m = memoryFhir([canonicalFact()]); let lost = false;
  m.hooks.afterWrite = w => { if (w.resource.resourceType === "Provenance" && !lost) { lost = true; throw new Error("lost audit response"); } };
  m.hooks.beforeSearch = type => { if (lost && type === "Provenance") throw new Error("lookup unavailable"); };
  const c = command([{ kind: "reassert", key: keyFor(), baseline: factBaseline(observations(m)) }]);
  const first = await run(m, c);
  assert.equal(first.outcomes[0].status, "unconfirmed"); assert.equal(first.complete, false);
  m.hooks.beforeSearch = undefined; m.hooks.afterWrite = undefined;
  const replay = await run(m, c);
  assert.equal(replay.outcomes[0].status, "already-applied"); assert.equal(replay.complete, true);
  assert.equal(observationWrites(m).length, 0); assert.equal(audits(m).length, 1);
  assert.equal(audits(m)[0].activity?.coding?.[0].code, DIAGNOSIS_FINDING_REASSERTION_CODE);
  assert.equal(parseFindingOperation(observations(m)[0]), undefined);
});

test("eye change is two facts; an occupied differing destination conflicts without overwriting it", async () => {
  const m = memoryFhir([canonicalFact()]);
  const c = command([factTarget(keyFor("OS")), factTarget(keyFor(), factBaseline(observations(m)), endState({ status: "retired" }))]);
  const result = await run(m, c);
  assert.deepEqual(result.outcomes.map(o => o.status), ["applied", "applied"]);
  assert.deepEqual(projection(m).currentFacts.map(f => [f.eye, f.status]), [["OD", "retired"], ["OS", "live"]]);
  const occupied = memoryFhir([canonicalFact(), { ...canonicalFact("left", "OS"), valueBoolean: false }]);
  const rejected = await run(occupied, command([factTarget(keyFor("OS")), factTarget(keyFor(), factBaseline(observations(occupied)), endState({ status: "retired" }))]));
  assert.deepEqual(rejected.outcomes.map(o => o.status), ["conflict", "not-attempted"]);
  assert.equal(occupied.writes.length, 0); assert.equal(occupied.resources.get("Observation/canonical")?.status, "preliminary");
});

for (const eyes of [["OD"], ["OD", "OS"]] as const) test(`UNKNOWN retirement follows ${eyes.join("+")} destinations and replays via the source`, async () => {
  const m = memoryFhir([atomic("unknown", "UNKNOWN")]);
  const c = command([{ kind: "legacy-retire", sourceReference: "Observation/unknown", baseline: { versionId: "v1" } }, ...eyes.map(eye => factTarget(keyFor(eye)))]);
  const result = await run(m, c);
  assert.equal(result.complete, true);
  assert.equal(observationWrites(m).at(-1)?.resource.id, "unknown");
  assert.equal(projection(m).unresolved[0].status, "retired"); assert.equal(projection(m).unresolved[0].baseline, undefined);
  const replay = await run(m, c);
  assert.ok(replay.outcomes.every(o => o.status === "already-applied"));
  assert.equal(observationWrites(m).length, eyes.length + 1); assert.equal(audits(m).length, eyes.length + 1);
});

test("W22 a destination refusal preserves the unresolved UNKNOWN source, even when retirement was submitted first", async () => {
  const m = memoryFhir([atomic("unknown", "UNKNOWN")]);
  m.hooks.beforeWrite = w => { if (w.method === "POST" && w.resource.resourceType === "Observation") throw httpError(403); };
  const result = await run(m, command([{ kind: "legacy-retire", sourceReference: "Observation/unknown", baseline: { versionId: "v1" } }, factTarget()]));
  assert.equal(result.outcomes[0].status, "not-attempted"); assert.equal(result.outcomes[1].status, "refused");
  assert.equal(projection(m).unresolved[0].status, "live"); assert.equal(audits(m).length, 0);
});

test("duplicates throw 400; missing baselines refuse; incomplete loads attempt no targets", async () => {
  const m = memoryFhir();
  for (const targets of [[factTarget(), { kind: "reassert", key: keyFor(), baseline: { kind: "canonical", reference: "Observation/a", versionId: "v1" } }],
    [{ kind: "legacy-retire", sourceReference: "Observation/a", baseline: { versionId: "v1" } }, { kind: "legacy-retire", sourceReference: "Observation/a", baseline: { versionId: "v1" } }]]) {
    await assert.rejects(() => run(m, command(targets)), (error: any) => error.status === 400);
  }
  const missing = await run(m, command([{ ...factTarget(), baseline: undefined }, factTarget(keyFor("OS"))]));
  assert.deepEqual(missing.outcomes.map(o => o.status), ["refused", "not-attempted"]);
  m.hooks.beforeSearch = () => { throw new Error("upstream secret"); };
  const unavailable = await run(m, command([factTarget(), factTarget(keyFor("OS"))]));
  assert.deepEqual(unavailable.outcomes.map(o => o.status), ["not-attempted", "not-attempted"]);
  assert.equal(m.writes.length, 0); assert.ok(!JSON.stringify(unavailable).includes("secret"));
});

test("W13 replay requires marker equality and a current-state rehash", async () => {
  const m = memoryFhir(); const c = command([factTarget()]); await run(m, c);
  const saved = observations(m)[0]; m.save({ ...saved, status: "entered-in-error" });
  const replay = await run(m, c);
  assert.equal(replay.outcomes[0].status, "conflict"); assert.equal(audits(m).length, 1);
});

test("W14 lost second write and failed reread return unconfirmed; unchanged replay resolves both exactly once", async () => {
  const m = memoryFhir(); let lost = false;
  m.hooks.afterWrite = w => { if (w.resource.resourceType === "Observation" && parseCurrentFindingEnvelope(w.resource).status === "valid" && w.resource.extension?.some(e => e.valueCodeableConcept?.coding?.some(c => c.code === "OS"))) { lost = true; throw new Error("lost response"); } };
  m.hooks.beforeRead = type => { if (lost && type === "Observation") throw new Error("read failed"); };
  m.hooks.beforeSearch = type => { if (lost && type === "Observation") throw new Error("search failed"); };
  const c = command([factTarget(), factTarget(keyFor("OS"))]);
  const first = await run(m, c);
  assert.deepEqual(first.outcomes.map(o => o.status), ["applied", "unconfirmed"]); assert.equal(first.complete, false);
  m.hooks.afterWrite = undefined; m.hooks.beforeRead = undefined; m.hooks.beforeSearch = undefined;
  const replay = await run(m, c);
  assert.deepEqual(replay.outcomes.map(o => o.status), ["already-applied", "already-applied"]);
  assert.equal(replay.complete, true); assert.equal(observations(m).length, 2); assert.equal(audits(m).length, 2); assert.equal(observationWrites(m).length, 2);
});

test("W15 unlink materializes only the addressed option and never attempts a Condition write", async () => {
  const source = snapshot("snapshot", ["nuclear-sclerosis", "cortical-cataract"]);
  const condition = { ...home("Condition/home"), evidence: [{ detail: [{ reference: "Observation/snapshot" }] }] };
  const m = memoryFhir([source, condition]); const fact = projection(m).currentFacts.find(f => f.key.optionCode === nuclear.optionCode)!;
  const result = await run(m, command([factTarget(fact.key, fact.baseline)]));
  assert.equal(result.complete, true);
  assert.equal(m.writes.filter(w => w.resource.resourceType === "Condition").length, 0);
  assert.deepEqual(projection(m).currentFacts.find(f => f.key.optionCode === nuclear.optionCode)?.homes, []);
  assert.deepEqual(projection(m).currentFacts.find(f => f.key.optionCode === "cortical-cataract")?.homes, ["Condition/home"]);
  assert.deepEqual(m.resources.get("Condition/home"), condition); assert.deepEqual(m.resources.get("Observation/snapshot"), source);
});

test("W19 already-applied replay leaves exactly one mutation audit", async () => {
  const m = memoryFhir(); const c = command([factTarget()]); await run(m, c);
  const replay = await run(m, c);
  assert.equal(replay.outcomes[0].status, "already-applied"); assert.equal(audits(m).length, 1);
  assert.equal(observationWrites(m).length, 1);
});

test("W20 repair-before-supersede preserves C1's frozen actor and expands self to the carrying record", async () => {
  const m = memoryFhir(); m.hooks.beforeWrite = w => { if (w.resource.resourceType === "Provenance") throw httpError(403); };
  const c1 = command([factTarget()]); const first = await run(m, c1);
  assert.equal(first.outcomes[0].status, "applied"); assert.equal(first.outcomes[0].auditPending, true); assert.equal(first.complete, false);
  const o = observations(m)[0]; const oldMarker = parseFindingOperation(o)!;
  m.hooks.beforeWrite = undefined;
  const c2 = command([factTarget(keyFor(), factBaseline(observations(m)), endState({ presence: "absent" }))]);
  const second = await executeFindingCommand({ ...writerContext(m), staffReference: "Practitioner/second", now: () => "2026-09-16T13:00:00.000Z" }, c2 as FindingCommand);
  assert.equal(second.complete, true); assert.equal(audits(m).length, 2);
  const repaired = audits(m).filter(a => a.recorded === oldMarker.audit.recorded);
  assert.equal(repaired.length, 1); assert.equal(repaired[0].agent[0].who.reference, oldMarker.audit.actor);
  assert.ok(repaired[0].target.some(t => t.reference === `Observation/${o.id}`)); assert.ok(!repaired[0].target.some(t => t.reference === "self"));
});

test("failed prior-audit repair leaves the old marker and content intact", async () => {
  const m = memoryFhir(); m.hooks.beforeWrite = w => { if (w.resource.resourceType === "Provenance") throw httpError(403); };
  await run(m, command([factTarget()])); const before = observations(m)[0];
  const result = await run(m, command([factTarget(keyFor(), factBaseline(observations(m)), endState({ presence: "absent" }))]));
  assert.equal(result.outcomes[0].status, "not-attempted"); assert.equal(result.outcomes[0].reason, "prior-audit-unrepaired");
  assert.deepEqual(observations(m)[0], before); assert.equal(observationWrites(m).length, 1);
});

test("W23 conditional-create loser returns conflict and writes no mutation audit", async () => {
  const m = memoryFhir(); let release!: () => void; let arrived = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  m.hooks.beforeWrite = async w => { if (w.method === "POST" && w.resource.resourceType === "Observation") { if (++arrived === 2) release(); await barrier; } };
  const results = await Promise.all([run(m, command([factTarget()])), run(m, command([factTarget(keyFor(), { kind: "absent", key: keyFor() }, endState({ presence: "absent" }))]))]);
  assert.deepEqual(results.map(r => r.outcomes[0].status).sort(), ["applied", "conflict"]);
  assert.equal(observations(m).length, 1); assert.equal(audits(m).length, 1);
});

test("W24 unchanged replay preserves a second-target version conflict", async () => {
  const left = canonicalFact("left", "OS"); const m = memoryFhir([left]);
  const baseline = factBaseline([left], "OS"); m.save({ ...left, valueBoolean: false });
  const c = command([factTarget(), factTarget(keyFor("OS"), baseline, endState({ qualifiers: { grade: "3+" } }))]);
  const first = await run(m, c); const replay = await run(m, c);
  assert.deepEqual(first.outcomes.map(o => o.status), ["applied", "conflict"]);
  assert.deepEqual(replay.outcomes.map(o => o.status), ["already-applied", "conflict"]);
  assert.equal(audits(m).length, 1); assert.equal(observationWrites(m).length, 1);
});

test("W25 reused command id with different content and a fresh baseline owes a distinct audit", async () => {
  const m = memoryFhir(); const first = command([factTarget()]); await run(m, first);
  const second = command([factTarget(keyFor(), factBaseline(observations(m)), endState({ presence: "absent" }))], first.commandId);
  const result = await run(m, second);
  assert.equal(result.outcomes[0].status, "applied"); assert.equal(audits(m).length, 2);
  assert.notEqual(audits(m)[0].meta?.tag?.[0].code, audits(m)[1].meta?.tag?.[0].code);
  assert.equal(projection(m).currentFacts[0].presence, "absent");
});

test("invalid qualifiers and foreign or missing homes refuse before any write", async () => {
  for (const value of [endState({ qualifiers: { unknown: "value" } }), endState({ qualifiers: { grade: "invalid" } }),
    endState({ qualifiers: { grade: 2 } }), endState({ homes: ["Condition/missing"] })]) {
    const m = memoryFhir(); const result = await run(m, command([factTarget(keyFor(), undefined, value)]));
    assert.equal(result.outcomes[0].status, "refused"); assert.equal(m.writes.length, 0);
  }
  const m = memoryFhir([{ ...home("Condition/foreign"), subject: { reference: "Patient/other" } }]);
  const foreign = await run(m, command([factTarget(keyFor(), undefined, endState({ homes: ["Condition/foreign"] }))]));
  assert.equal(foreign.outcomes[0].status, "not-attempted"); assert.equal(m.writes.length, 0);
});

test("a retired UNKNOWN without this command marker cannot be retired again", async () => {
  const m = memoryFhir([{ ...atomic("unknown", "UNKNOWN"), status: "cancelled" }]);
  const result = await run(m, command([{ kind: "legacy-retire", sourceReference: "Observation/unknown", baseline: { versionId: "v1" } }]));
  assert.equal(result.outcomes[0].status, "conflict"); assert.equal(m.writes.length, 0);
});

test("an adoption replay locates its new canonical owner before rechecking the obsolete legacy locator", async () => {
  const m = memoryFhir([atomic()]); const c = command([factTarget(keyFor(), factBaseline(observations(m)), endState({ qualifiers: { grade: "2+" } }))]);
  await run(m, c); const replay = await run(m, c);
  assert.equal(replay.outcomes[0].status, "already-applied"); assert.equal(observationWrites(m).length, 1);
  assert.equal(audits(m).length, 1);
});

test("same key with different property order reuses its operation and audit", async () => {
  const m = memoryFhir(); const c = command([factTarget()]); await run(m, c);
  const reordered = Object.fromEntries(Object.entries(keyFor()).reverse());
  const retry = await run(m, { ...c, targets: [{ ...c.targets[0] as object, key: reordered, baseline: { kind: "absent", key: reordered } }] });
  assert.equal(retry.outcomes[0].status, "already-applied"); assert.equal(observationWrites(m).length, 1); assert.equal(audits(m).length, 1);
});

test("absent baseline permits a retired-only legacy record without modifying it", async () => {
  const old = { ...atomic(), status: "entered-in-error" as const }; const m = memoryFhir([old]);
  const result = await run(m, command([factTarget()]));
  assert.equal(result.outcomes[0].status, "applied"); assert.equal(observations(m).length, 2);
  assert.deepEqual(m.resources.get("Observation/atomic"), old);
});

test("missing baseline is refused even for a matching marker; reassert cannot use an absent baseline", async () => {
  const m = memoryFhir(); const c = command([factTarget()]); await run(m, c);
  const missing = await run(m, { ...c, targets: [{ ...c.targets[0] as object, baseline: undefined }] });
  assert.equal(missing.outcomes[0].status, "refused");
  const absent = await run(m, command([{ kind: "reassert", key: keyFor(), baseline: { kind: "absent", key: keyFor() } }]));
  assert.equal(absent.outcomes[0].status, "refused"); assert.equal(observationWrites(m).length, 1);
});

test("canonical key extras are rejected before an invalid identity envelope can be persisted", async () => {
  const m = memoryFhir(); const bad = { ...keyFor(), operation: "misplaced" };
  await assert.rejects(() => run(m, command([factTarget(bad)])), (error: any) => error.status === 400);
  assert.equal(m.writes.length, 0);
});

test("extent key order cannot change the persisted digest or duplicate its operation", async () => {
  const effective = structuredClone(definitions);
  const d = effective.find(d => d.stableKey === keyFor().stableKey)!;
  const option = (d.valueSchema.fields as any)[lensField].options.find((o: any) => o.code === nuclear.optionCode);
  option.qualifiers = [{ kind: "extent", key: "extent", display: "Synthetic extent" }];
  const key = keyFor(); const q = { key: "extent" };
  const apply = (m: ReturnType<typeof memoryFhir>, c: ReturnType<typeof command>) => executeFindingCommand({ ...writerContext(m), definitions: effective }, c as FindingCommand);
  const m = memoryFhir(); const c = command([factTarget(key, undefined, endState({ qualifiers: { [q.key]: { from: 2, to: 5, clockwise: true } } }))]);
  const first = await apply(m, c); assert.equal(first.complete, true);
  const retry = { ...c, targets: [{ ...c.targets[0] as object, state: endState({ qualifiers: { [q.key]: { clockwise: true, to: 5, from: 2 } } }) }] };
  assert.equal((await apply(m, retry)).outcomes[0].status, "already-applied");
  assert.equal(observationWrites(m).length, 1); assert.equal(audits(m).length, 1);
});

test("a definitive audit refusal remains applied/pending and does not block a different target", async () => {
  const m = memoryFhir(); let refused = false;
  m.hooks.beforeWrite = w => { if (w.resource.resourceType === "Provenance" && !refused) { refused = true; throw httpError(403); } };
  const result = await run(m, command([factTarget(), factTarget(keyFor("OS"))]));
  assert.deepEqual(result.outcomes.map(o => o.status), ["applied", "applied"]);
  assert.equal(result.outcomes[0].auditPending, true); assert.equal(result.outcomes[1].auditPending, undefined);
  assert.equal(result.complete, false); assert.equal(observations(m).length, 2); assert.equal(audits(m).length, 1);
});

test("unchanged is reserved for no audit debt; a new command repairs debt before its planned write", async () => {
  const m = memoryFhir(); m.hooks.beforeWrite = w => { if (w.resource.resourceType === "Provenance") throw httpError(403); };
  await run(m, command([factTarget()])); m.hooks.beforeWrite = undefined;
  const second = await run(m, command([factTarget(keyFor(), factBaseline(observations(m)))]));
  assert.equal(second.outcomes[0].status, "applied"); assert.equal(second.complete, true); assert.equal(audits(m).length, 2);
  assert.equal(observationWrites(m).length, 2);
});

test("a definitive reassert audit refusal stops later targets and exposes the known version", async () => {
  const m = memoryFhir([canonicalFact()]); m.hooks.beforeWrite = () => { throw httpError(403); };
  const result = await run(m, command([{ kind: "reassert", key: keyFor(), baseline: factBaseline(observations(m)) }, factTarget(keyFor("OS"))]));
  assert.deepEqual(result.outcomes.map(o => o.status), ["refused", "not-attempted"]);
  assert.equal(result.outcomes[0].versionId, "v1"); assert.equal(observationWrites(m).length, 0);
});
