import assert from "node:assert/strict";
import { test } from "node:test";
import type { Condition } from "@medplum/fhirtypes";
import { doctorNewness, diagnosisHistoryMatch, twelveMonthsBefore } from "../src/clinical-graph/diagnosis-newness.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../src/clinical-graph/diagnosis-pick-endpoint.js";

function condition(key?: string, encounterId = "prior"): Condition {
  return { resourceType: "Condition", id: "dx", subject: { reference: "Patient/p1" }, encounter: { reference: `Encounter/${encounterId}` },
    ...(key ? { identifier: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: key }] } : {}),
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H52.13" }] },
  };
}

test("history identity handles current, legacy and bare catalog keys without laterality", () => {
  assert.equal(diagnosisHistoryMatch(condition("current::synthetic::right", "current"), condition("prior::synthetic::left")), "catalog-key");
  assert.equal(diagnosisHistoryMatch(condition("synthetic::bilateral"), condition("synthetic")), "catalog-key");
  assert.equal(diagnosisHistoryMatch(condition("different"), condition("synthetic")), undefined, "different catalog keys must not collapse into their broad ICD category");
  assert.equal(diagnosisHistoryMatch(condition(), condition()), "icd10-category");
});

test("explicit Established wins over legacy Doctor New", () => {
  assert.deepEqual(doctorNewness("Condition/dx", { conditionReference: "Condition/dx", encounterId: "current", value: "established", setBy: "Practitioner/p1", setAt: "2026-09-14T12:00:00Z" },
    { conditionReference: "Condition/dx", encounterId: "current", status: "new", setBy: "Practitioner/p1", setAt: "2026-09-14T11:00:00Z", updatedAt: "2026-09-14T11:00:00Z" }),
  { conditionReference: "Condition/dx", value: "established", source: "doctor" });
});

test("twelve months is a calendar window and clamps leap day", () => {
  assert.equal(new Date(twelveMonthsBefore(Date.parse("2024-02-29T12:00:00Z"))).toISOString(), "2023-02-28T12:00:00.000Z");
});

test("Postgres migration preserves legacy New and the doctor's override survives independent reload", { skip: !process.env.ODOS_NEWNESS_TEST_POSTGRES }, async () => {
  const { Pool } = await import("pg");
  const { readFile } = await import("node:fs/promises");
  const { PgDiagnosisVisitStatusStore } = await import("../src/clinical-graph/diagnosis-visit-status-store.js");
  const connectionString = process.env.ODOS_NEWNESS_TEST_POSTGRES!;
  const pool = new Pool({ connectionString });
  await pool.query(await readFile(new URL("../../data/migrations/2026-07-21-encounter-diagnosis-statuses.sql", import.meta.url), "utf8"));
  await pool.query("INSERT INTO odos_encounter_diagnosis_statuses VALUES ('Condition/legacy', 'current', 'new', 'Practitioner/doctor', now(), now()) ON CONFLICT DO NOTHING");
  const first = new PgDiagnosisVisitStatusStore({ postgresUrl: connectionString });
  const second = new PgDiagnosisVisitStatusStore({ postgresUrl: connectionString });
  try {
    assert.equal((await first.listNewnessOverrides("current")).find((row) => row.conditionReference === "Condition/legacy")?.value, "new");
    await first.upsertNewnessOverride({ encounterId: "current", conditionReference: "Condition/legacy", value: "established", setBy: "Practitioner/doctor", at: "2026-09-14T12:00:00Z" });
    await first.upsert({ encounterId: "current", conditionReference: "Condition/legacy", status: "stable", setBy: "Practitioner/doctor", at: "2026-09-14T12:05:00Z" });
    assert.equal((await second.listNewnessOverrides("current"))[0]?.value, "established");
    await first.upsert({ encounterId: "current", conditionReference: "Condition/later-legacy", status: "new", setBy: "Practitioner/doctor", at: "2026-09-14T12:00:00Z" });
    await first.upsert({ encounterId: "current", conditionReference: "Condition/later-legacy", status: "improved", setBy: "Practitioner/doctor", at: "2026-09-14T12:05:00Z" });
    assert.equal((await second.listNewnessOverrides("current")).find((row) => row.conditionReference === "Condition/later-legacy")?.value, "new");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM odos_schema_migrations WHERE filename = '2026-09-14-diagnosis-newness-overrides.sql'")).rows[0].count, 1);
    await assert.rejects(pool.query("INSERT INTO odos_encounter_diagnosis_newness_overrides VALUES ('current', 'Condition/bad', 'invalid', 'Practitioner/doctor', now())"), /check constraint/);
  } finally {
    await first.close();
    await second.close();
    await pool.end();
  }
});

test("newness endpoint locks signed encounters and persists a doctor choice only on the matching patient diagnosis", async () => {
  const { handleDiagnosisNewnessUpdateRequest } = await import("../src/clinical-graph/diagnosis-newness-endpoint.js");
  const { buildEncounterDiagnosisCondition } = await import("../src/fhir/condition.js");
  const encounter = { resourceType: "Encounter", id: "current", status: "in-progress", subject: { reference: "Patient/p1" }, diagnosis: [{ condition: { reference: "Condition/dx" } }] };
  const diagnosis = { ...buildEncounterDiagnosisCondition({ patientReference: "Patient/p1", encounterReference: "Encounter/current", code: { text: "Synthetic diagnosis" } }), id: "dx" };
  let saved: unknown;
  let writes = 0;
  const deps = {
    authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider" as const,
      fhir: { baseUrl: "http://synthetic.invalid/fhir/R4", read: async (type: string) => type === "Encounter" ? encounter : diagnosis, search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }) },
    }),
    store: { listByEncounter: async () => [], upsert: async () => { throw new Error("unexpected visit-status write"); },
      listNewnessOverrides: async () => [], upsertNewnessOverride: async (input: unknown) => { writes += 1; saved = input; return { ...(input as object), setAt: "2026-09-14T12:00:00Z" }; },
    },
  } as unknown as Parameters<typeof handleDiagnosisNewnessUpdateRequest>[0];
  const request = { authHeader: "Bearer synthetic", params: { encounterId: "current", conditionId: "dx" }, body: { value: "established" } };
  assert.equal((await handleDiagnosisNewnessUpdateRequest(deps, request)).status, 200);
  assert.equal((saved as { value: string }).value, "established");
  encounter.status = "finished";
  assert.equal((await handleDiagnosisNewnessUpdateRequest(deps, { ...request, body: { value: "new" } })).status, 409);
  assert.equal(writes, 1);
  encounter.status = "in-progress";
  diagnosis.subject.reference = "Patient/another";
  assert.equal((await handleDiagnosisNewnessUpdateRequest(deps, request)).status, 409);
  assert.equal(writes, 1);
});

function historyFixture() {
  const current = { resourceType: "Encounter", id: "current", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/p1" }, period: { start: "2026-09-14T12:00:00Z" }, diagnosis: [{ condition: { reference: "Condition/dx" } }] };
  const currentCondition = condition("current::synthetic::right", "current");
  currentCondition.verificationStatus = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] };
  currentCondition.category = [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis" }] }];
  const resources: Record<string, unknown> = { "Encounter/current": current, "Condition/dx": currentCondition };
  const visits: unknown[] = [];
  const overrides: import("../src/clinical-graph/diagnosis-newness-types.js").DiagnosisNewnessOverride[] = [];
  const legacy: import("../src/clinical-graph/diagnosis-visit-status-store.js").DiagnosisVisitStatusRow[] = [];
  const fhir = {
    baseUrl: "http://synthetic.invalid/fhir/R4",
    read: async (type: string, id: string) => {
      if (!resources[`${type}/${id}`]) throw new Error("Unreadable history");
      return structuredClone(resources[`${type}/${id}`]);
    },
    search: async () => ({ resourceType: "Bundle", type: "searchset", entry: visits.map((resource) => ({ resource })) }),
  } as import("../src/clinical-graph/diagnosis-newness.js").DiagnosisHistoryClient;
  const store = {
    listByEncounter: async () => legacy,
    upsert: async () => { throw new Error("suggestions must not write visit status"); },
    listNewnessOverrides: async () => structuredClone(overrides),
    upsertNewnessOverride: async (input: { conditionReference: string; encounterId: string; value: "new" | "established"; setBy: string; at: string }) => {
      const row = { ...input, setAt: input.at };
      overrides.splice(0, overrides.length, row);
      return row;
    },
  };
  return {
    deps: { authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider" as const, fhir }), store },
    overrides, legacy, current, currentCondition, resources, visits,
    addVisit(id: string, start: string, status: string) {
      const prior = condition(`${id}::synthetic::left`, id);
      prior.id = id;
      prior.clinicalStatus = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: status }] };
      resources[`Condition/${id}`] = prior;
      visits.push({ ...current, id, period: { start }, diagnosis: [{ condition: { reference: `Condition/${id}` } }] });
      return prior;
    },
  };
}

async function readHistory(fixture: ReturnType<typeof historyFixture>) {
  const { handleDiagnosisNewnessReadRequest } = await import("../src/clinical-graph/diagnosis-newness-endpoint.js");
  const result = await handleDiagnosisNewnessReadRequest(fixture.deps, { authHeader: "Bearer synthetic", params: { encounterId: "current" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return (result.body as { rows: import("../src/clinical-graph/diagnosis-newness-types.js").DiagnosisNewnessRow[] }).rows[0]!;
}

for (const [scenario, history, expected] of [
  ["most recent resolved supersedes older active", [["2026-03-14T12:00:00Z", "active"], ["2026-04-14T12:00:00Z", "resolved"]], "new"],
  ["most recent active supersedes older resolved", [["2026-03-14T12:00:00Z", "resolved"], ["2026-04-14T12:00:00Z", "active"]], "established"],
  ["outside twelve-month window", [["2025-08-14T12:00:00Z", "active"]], "new"],
  ["no prior", [], "new"],
  ["resolved prior", [["2026-04-14T12:00:00Z", "resolved"]], "new"],
  ["non-resolved prior", [["2026-04-14T12:00:00Z", "inactive"]], "established"],
] as const) {
  test(`New / Established suggestion: ${scenario}`, async () => {
    const fixture = historyFixture();
    history.forEach(([date, status], index) => fixture.addVisit(`prior-${index}`, date, status));
    const row = await readHistory(fixture);
    assert.equal(row.value, expected);
    assert.equal(row.source, "suggestion");
    assert.equal(fixture.overrides.length, 0, "reading must never freeze the suggestion");
  });
}

test("doctor Established beats computed New after reload; suggestion updates when prior resolution changes", async () => {
  const fixture = historyFixture();
  const prior = fixture.addVisit("prior", "2026-04-14T12:00:00Z", "active");
  assert.equal((await readHistory(fixture)).value, "established");
  prior.clinicalStatus!.coding![0]!.code = "resolved";
  assert.equal((await readHistory(fixture)).value, "new");
  const { handleDiagnosisNewnessUpdateRequest } = await import("../src/clinical-graph/diagnosis-newness-endpoint.js");
  const saved = await handleDiagnosisNewnessUpdateRequest(fixture.deps, { authHeader: "Bearer synthetic", params: { encounterId: "current", conditionId: "dx" }, body: { value: "established" } });
  assert.equal(saved.status, 200);
  assert.deepEqual(await readHistory(fixture), { conditionReference: "Condition/dx", value: "established", source: "doctor" });
});

test("stye recurrence is New after Resolved this visit while clinical status stays active", async () => {
  const fixture = historyFixture();
  fixture.addVisit("first", "2026-03-14T12:00:00Z", "active");
  const followup = fixture.addVisit("followup", "2026-04-14T12:00:00Z", "active");
  const reads: string[] = [];
  fixture.deps.store.listByEncounter = async (encounterId?: string) => {
    reads.push(encounterId!);
    return encounterId === "followup" ? [{ conditionReference: "Condition/followup", encounterId, status: "resolved-this-visit", setBy: "Practitioner/doctor", setAt: "2026-04-14T12:00:00Z", updatedAt: "2026-04-14T12:00:00Z" }] : [];
  };
  assert.equal((await readHistory(fixture)).value, "new");
  assert.equal(followup.clinicalStatus!.coding![0]!.code, "active");
  assert.ok(reads.includes("followup"), "prior visit status must come from the store");
});

test("mixed-eye latest visit stays Established when only one matching eye is resolved", async () => {
  const fixture = historyFixture();
  fixture.addVisit("prior", "2026-04-14T12:00:00Z", "resolved");
  const activeEye = condition("prior::synthetic::right", "prior");
  activeEye.id = "active-eye";
  activeEye.clinicalStatus = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] };
  fixture.resources["Condition/active-eye"] = activeEye;
  (fixture.visits[0] as { diagnosis: { condition: { reference: string } }[] }).diagnosis.push({ condition: { reference: "Condition/active-eye" } });
  assert.equal((await readHistory(fixture)).value, "established");
});

test("history failure preserves doctor rows and marks only unsuggested rows unavailable", async () => {
  const fixture = historyFixture();
  const other = { ...structuredClone(fixture.currentCondition), id: "other" };
  fixture.resources["Condition/other"] = other;
  fixture.current.diagnosis.push({ condition: { reference: "Condition/other" } });
  fixture.overrides.push({ conditionReference: "Condition/dx", encounterId: "current", value: "established", setBy: "Practitioner/doctor", setAt: "2026-09-14T12:00:00Z" });
  fixture.current.period.start = "2026-09-14";
  const { handleDiagnosisNewnessReadRequest } = await import("../src/clinical-graph/diagnosis-newness-endpoint.js");
  const result = await handleDiagnosisNewnessReadRequest(fixture.deps, { authHeader: "Bearer synthetic", params: { encounterId: "current" } });
  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { rows: unknown[] }).rows, [
    { conditionReference: "Condition/dx", value: "established", source: "doctor" },
    { conditionReference: "Condition/other", source: "unavailable" },
  ]);
});
