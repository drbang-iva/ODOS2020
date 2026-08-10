import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type {
  AccessPolicy,
  Bundle,
  ClientApplication,
  Condition,
  Encounter,
  Observation,
  Patient,
  Practitioner,
  ProjectMembership,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import express from "express";
import {
  buildMedplumAccessPolicy,
  buildProjectMembershipAccess,
  getRoleDeclaration,
  type PracticeRoleId,
} from "../src/authz/roles.js";
import {
  handleDiagnosisPullRequest,
  handlePreviousExamsReadRequest,
  registerDiagnosisCarryForwardRoutes,
  type DiagnosisCarryForwardFhirClient,
  type PreviousExamsPage,
} from "../src/clinical-graph/diagnosis-carry-forward-endpoint.js";
import { readDiagnosisCarryState } from "../src/clinical-graph/diagnosis-carry-provenance.js";
import {
  buildEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition,
  type ConditionVerificationStatusCode,
} from "../src/fhir/condition.js";
import { lateralityConcept, ODOS_EXTENSION_URLS } from "../src/fhir/ophthalmology/extensions.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../src/clinical-graph/diagnosis-pick-endpoint.js";
import { createAuthenticatedFhirClient, loadRepoEnv } from "./integration-helpers.js";
import { createMedplumClient } from "../src/fhir-client.js";
import { searchAll } from "../src/fhir-search.js";
import { TEST_FHIR_AUDIT_CONTEXT, TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";

const AUTH_CLINICIAN = "Bearer clinician";
const AUTH_FORBIDDEN = "Bearer forbidden";

test("GET previous exams returns 401 when unauthenticated", async (t) => {
  const base = await startPreviousExamRoutes(t, new MemoryFhir(), "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current/previous-exams`);

  assert.equal(response.status, 401);
});

test("GET previous exams returns 403 without chart.read", async (t) => {
  const base = await startPreviousExamRoutes(t, new MemoryFhir(), "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current/previous-exams`, {
    headers: { Authorization: AUTH_FORBIDDEN },
  });

  assert.equal(response.status, 403);
});

test("POST previous exams returns 401 when unauthenticated", async (t) => {
  const base = await startPreviousExamRoutes(t, new MemoryFhir(), "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current/previous-exams`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceEncounterReference: "Encounter/prior",
      sourceConditionReference: "Condition/prior-diagnosis",
    }),
  });

  assert.equal(response.status, 401);
});

test("POST previous exams returns 403 without chart.write", async (t) => {
  const base = await startPreviousExamRoutes(t, new MemoryFhir(), "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current/previous-exams`, {
    method: "POST",
    headers: { Authorization: AUTH_FORBIDDEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceEncounterReference: "Encounter/prior",
      sourceConditionReference: "Condition/prior-diagnosis",
    }),
  });

  assert.equal(response.status, 403);
});

test("carry provenance walks the actual unedited Condition chain without a depth cap", async () => {
  const fhir = carryChainFhir(260);
  const newest = fhir.resource<Condition>("Condition", "carry-condition-260");
  const state = await readDiagnosisCarryState(fhir, newest, []);

  assert.equal(state.pulledFromDate, "2025-12-16T09:00:00.000Z");
  assert.equal(state.unchangedSinceDate, "2025-04-01T09:00:00.000Z");
  assert.equal(state.edited, false);
  assert.equal(state.integrityWarning, undefined);
});

test("a later Provenance on a middle Condition stops unchanged aging at that source encounter", async () => {
  const fhir = carryChainFhir(3);
  fhir.resources.push(targetProvenance(
    "middle-condition-edit",
    "2025-04-03T13:00:00.000Z",
    ["Condition/carry-condition-2"],
    "UPDATE",
    "Update",
  ));

  const state = await readDiagnosisCarryState(
    fhir,
    fhir.resource<Condition>("Condition", "carry-condition-3"),
    [],
  );

  assert.equal(state.pulledFromDate, "2025-04-03T09:00:00.000Z");
  assert.equal(state.unchangedSinceDate, "2025-04-03T09:00:00.000Z");
  assert.equal(state.edited, false);
});

test("a later Provenance on a middle carried Observation also stops unchanged aging there", async () => {
  const fhir = carryChainFhir(3);
  fhir.resource<Provenance>("Provenance", "carry-provenance-2").target.push({
    reference: "Observation/middle-carried-finding",
  });
  fhir.resources.push(targetProvenance(
    "middle-finding-edit",
    "2025-04-03T13:00:00.000Z",
    ["Observation/middle-carried-finding"],
    "UPDATE",
    "Update",
  ));

  const state = await readDiagnosisCarryState(
    fhir,
    fhir.resource<Condition>("Condition", "carry-condition-3"),
    [],
  );

  assert.equal(state.unchangedSinceDate, "2025-04-03T09:00:00.000Z");
  assert.equal(state.edited, false);
});

test("a later finding Provenance edits the diagnosis and removes carried from only that finding", async () => {
  const fhir = carryChainFhir(1);
  const first = carryObservation("carried-first", "carry-encounter-1");
  const second = carryObservation("carried-second", "carry-encounter-1");
  fhir.resources.push(first, second);
  const carry = fhir.resource<Provenance>("Provenance", "carry-provenance-1");
  carry.target.push({ reference: "Observation/carried-first" }, { reference: "Observation/carried-second" });
  fhir.resources.push(targetProvenance(
    "finding-edit",
    "2025-04-02T13:00:00.000Z",
    ["Observation/carried-first"],
    "UPDATE",
    "Update",
  ));

  const state = await readDiagnosisCarryState(
    fhir,
    fhir.resource<Condition>("Condition", "carry-condition-1"),
    [first, second],
  );

  assert.equal(state.edited, true);
  assert.equal(state.unchangedSinceDate, undefined);
  assert.deepEqual(state.observationCarried, {
    "Observation/carried-first": false,
    "Observation/carried-second": true,
  });
});

test("a later Provenance on a carried Observation still edits the diagnosis after that row leaves the active bundle", async () => {
  const fhir = carryChainFhir(1);
  fhir.resource<Provenance>("Provenance", "carry-provenance-1").target.push({
    reference: "Observation/cleared-carried-finding",
  });
  fhir.resources.push(targetProvenance(
    "cleared-finding-edit",
    "2025-04-02T13:00:00.000Z",
    ["Observation/cleared-carried-finding"],
    "UPDATE",
    "Update",
  ));

  const state = await readDiagnosisCarryState(
    fhir,
    fhir.resource<Condition>("Condition", "carry-condition-1"),
    [],
  );

  assert.equal(state.edited, true);
  assert.equal(state.unchangedSinceDate, undefined);
});

test("carry provenance compares recorded instants and fails closed on tied or invalid target timestamps", async () => {
  const offsetFhir = carryChainFhir(1);
  offsetFhir.resource<Provenance>("Provenance", "carry-provenance-1").recorded = "2025-04-02T12:30:00.000Z";
  offsetFhir.resources.push(targetProvenance(
    "offset-edit",
    "2025-04-02T09:00:00.000-04:00",
    ["Condition/carry-condition-1"],
    "UPDATE",
    "Update",
  ));
  const offsetState = await readDiagnosisCarryState(
    offsetFhir,
    offsetFhir.resource<Condition>("Condition", "carry-condition-1"),
    [],
  );
  assert.equal(offsetState.edited, true);

  for (const recorded of [
    "2025-04-02T12:30:00.000Z",
    "2025-02-30T12:30:00.000Z",
    "not-an-instant",
  ]) {
    const fhir = carryChainFhir(1);
    fhir.resource<Provenance>("Provenance", "carry-provenance-1").recorded = "2025-04-02T12:30:00.000Z";
    fhir.resources.push(targetProvenance(
      recorded === "2025-04-02T12:30:00.000Z" ? "ambiguous-tie" : `ambiguous-invalid-${recorded.length}`,
      recorded,
      ["Condition/carry-condition-1"],
      "UPDATE",
      "Update",
    ));

    const state = await readDiagnosisCarryState(
      fhir,
      fhir.resource<Condition>("Condition", "carry-condition-1"),
      [],
    );
    assert.equal(state.edited, true, recorded);
    assert.equal(state.unchangedSinceDate, undefined, recorded);
    assert.match(state.integrityWarning ?? "", /timestamp/i, recorded);
  }
});

test("carry provenance follows every target-search Bundle page before deciding which record is latest", async () => {
  const fhir = carryChainFhir(1);
  const targetReference = "Condition/carry-condition-1";
  fhir.provenancePageTarget = targetReference;
  fhir.provenancePages = [
    [fhir.resource<Provenance>("Provenance", "carry-provenance-1")],
    [targetProvenance(
      "paged-condition-edit",
      "2025-04-02T13:00:00.000Z",
      [targetReference],
      "UPDATE",
      "Update",
    )],
  ];

  const state = await readDiagnosisCarryState(
    fhir,
    fhir.resource<Condition>("Condition", "carry-condition-1"),
    [],
  );

  assert.equal(state.edited, true);
  assert.deepEqual(fhir.followedUrls, ["/fhir/R4/Provenance?_page=2"]);
});

for (const mutation of ["wrong-code", "wrong-system", "wrong-text", "wrong-role", "missing-condition"] as const) {
  test(`carry provenance rejects ${mutation} instead of relaxing its exact tuple and source-role contract`, async () => {
    const fhir = carryChainFhir(1);
    const carry = fhir.resource<Provenance>("Provenance", "carry-provenance-1");
    if (mutation === "wrong-code") carry.activity!.coding![0]!.code = "UPDATE";
    if (mutation === "wrong-system") carry.activity!.coding![0]!.system = "urn:wrong:data-operation";
    if (mutation === "wrong-text") carry.activity!.text = "Diagnosis copied";
    if (mutation === "wrong-role") carry.entity![0]!.role = "revision";
    if (mutation === "missing-condition") {
      carry.entity = [{ role: "source", what: { reference: "Observation/source-only" } }];
    }

    const state = await readDiagnosisCarryState(
      fhir,
      fhir.resource<Condition>("Condition", "carry-condition-1"),
      [],
    );
    assert.equal(state.pulledFromDate, undefined, mutation);
    assert.equal(state.unchangedSinceDate, undefined, mutation);
    assert.equal(state.edited, mutation === "missing-condition" || mutation === "wrong-role", mutation);
    if (mutation === "missing-condition" || mutation === "wrong-role") {
      assert.match(state.integrityWarning ?? "", /source Condition/i);
    }
  });
}

test("only source-role Observation entities can become prior absent offers", async () => {
  const fhir = carryChainFhir(1);
  const absent = carryObservation("prior-absent", "carry-encounter-0");
  absent.valueBoolean = false;
  fhir.resources.push(absent);
  fhir.resource<Provenance>("Provenance", "carry-provenance-1").entity!.push({
    role: "revision",
    what: { reference: "Observation/prior-absent" },
  });

  const state = await readDiagnosisCarryState(
    fhir,
    fhir.resource<Condition>("Condition", "carry-condition-1"),
    [],
  );

  assert.deepEqual(state.sourceAbsentSnapshots, []);
});

for (const [scenario, recorded] of [
  ["tied", "2025-04-03T12:00:00.000Z"],
  ["reversed", "2025-04-04T12:00:00.000Z"],
] as const) {
  test(`${scenario} ancestor carry instant fails the strict lineage chronology`, async () => {
    const fhir = carryChainFhir(2);
    fhir.resource<Provenance>("Provenance", "carry-provenance-1").recorded = recorded;

    const state = await readDiagnosisCarryState(
      fhir,
      fhir.resource<Condition>("Condition", "carry-condition-2"),
      [],
    );

    assert.equal(state.edited, true, recorded);
    assert.equal(state.unchangedSinceDate, undefined, recorded);
    assert.match(state.integrityWarning ?? "", /chronolog/i, recorded);
  });
}

for (const status of [404, 410]) {
  for (const reference of [
    "Condition/carry-condition-0",
    "Encounter/carry-encounter-0",
    "Observation/prior-absent",
  ]) {
    test(`${status} ${reference} returns a visible edited integrity state`, async () => {
      const fhir = carryChainFhir(1);
      if (reference.startsWith("Observation/")) {
        fhir.resource<Provenance>("Provenance", "carry-provenance-1").entity!.push({
          role: "source",
          what: { reference },
        });
      }
      fhir.readFailures.set(reference, status);

      const state = await readDiagnosisCarryState(
        fhir,
        fhir.resource<Condition>("Condition", "carry-condition-1"),
        [],
      );

      assert.equal(state.edited, true, `${status} ${reference}`);
      assert.equal(state.unchangedSinceDate, undefined, `${status} ${reference}`);
      assert.match(state.integrityWarning ?? "", /missing|gone|unavailable/i, `${status} ${reference}`);
    });
  }
}

test("clinician AccessPolicy makes Provenance reachable through the Patient compartment target", () => {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("clinician"));
  const provenanceRule = policy.resource?.find((rule) => rule.resourceType === "Provenance" &&
    rule.criteria === "Provenance?_compartment=%patient_compartment");

  assert.ok(provenanceRule);
  assert.equal(provenanceRule.interaction?.includes("create"), true);
  assert.equal(provenanceRule.interaction?.includes("read"), true);
});

test("carry provenance cycles terminate with a visible integrity warning", async () => {
  const fhir = carryChainFhir(2);
  const firstCarry = fhir.resource<Provenance>("Provenance", "carry-provenance-1");
  firstCarry.entity = [{ role: "source", what: { reference: "Condition/carry-condition-2" } }];

  const state = await readDiagnosisCarryState(
    fhir,
    fhir.resource<Condition>("Condition", "carry-condition-2"),
    [],
  );

  assert.equal(state.edited, true);
  assert.equal(state.unchangedSinceDate, undefined);
  assert.match(state.integrityWarning ?? "", /cycle/i);
});

test("pull posts one present finding atomically while preserving absent source provenance and rank gaps", async (t) => {
  const fhir = pullFhir();
  const sourceCondition = await fhir.read<Condition>("Condition", "source-dry-eye-od");
  const sourcePresent = await fhir.read<Observation>("Observation", "source-staining-present");
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current-pull/previous-exams`, {
    method: "POST",
    headers: { Authorization: AUTH_CLINICIAN, "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceEncounterReference: "Encounter/source-pull",
      sourceConditionReference: "Condition/source-dry-eye-od",
    }),
  });

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(fhir.transactions.length, 1);
  const { bundle, headers } = fhir.transactions[0]!;
  assert.equal(bundle.type, "transaction");
  assert.equal(headers.Prefer, "return=representation");
  assert.deepEqual(bundle.entry?.map((entry) => [entry.resource?.resourceType, entry.request?.method, entry.request?.url]), [
    ["Encounter", "PUT", "Encounter/current-pull"],
    ["Condition", "POST", "Condition"],
    ["Observation", "POST", "Observation"],
    ["Provenance", "POST", "Provenance"],
  ]);
  assert.equal(bundle.entry?.every((entry) => entry.fullUrl?.startsWith("urn:uuid:")), true);

  const encounterEntry = bundle.entry![0]!;
  const conditionEntry = bundle.entry![1]!;
  const observationEntry = bundle.entry![2]!;
  const provenanceEntry = bundle.entry![3]!;
  const pulledCondition = conditionEntry.resource as Condition;
  const pulledEncounter = encounterEntry.resource as Encounter;
  const pulledObservation = observationEntry.resource as Observation;
  const provenance = provenanceEntry.resource as Provenance;

  assert.deepEqual(pulledCondition.code, sourceCondition.code);
  assert.deepEqual(pulledCondition.extension, sourceCondition.extension);
  assert.equal(pulledCondition.subject.reference, "Patient/patient-1");
  assert.equal(pulledCondition.encounter?.reference, "Encounter/current-pull");
  assert.equal(pulledCondition.verificationStatus?.coding?.[0]?.code, "confirmed");
  assert.deepEqual(pulledCondition.identifier, [{
    system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
    value: "current-pull::dry_eye::right",
  }]);
  assert.deepEqual(pulledCondition.evidence?.flatMap((evidence) => evidence.detail ?? []), [
    { reference: observationEntry.fullUrl },
  ]);

  assert.equal(encounterEntry.request?.ifMatch, 'W/"7"');
  assert.deepEqual(pulledEncounter.diagnosis?.map((diagnosisRow) => diagnosisRow.rank), [1, 4, 5]);
  assert.equal(pulledEncounter.diagnosis?.at(-1)?.condition.reference, conditionEntry.fullUrl);

  assert.deepEqual(pulledObservation.code, sourcePresent.code);
  assert.equal(pulledObservation.subject?.reference, "Patient/patient-1");
  assert.equal(pulledObservation.encounter?.reference, "Encounter/current-pull");
  assert.equal(pulledObservation.status, "preliminary");
  assert.equal(pulledObservation.valueBoolean, true);
  assert.deepEqual(pulledObservation.extension, sourcePresent.extension);
  assert.deepEqual(pulledObservation.component, sourcePresent.component);
  assert.equal(pulledObservation.focus, undefined);
  assert.equal(JSON.stringify(pulledObservation).includes("source-staining-present"), false);

  assert.equal(provenance.activity?.coding?.[0]?.code, "CREATE");
  assert.equal(provenance.activity?.text, "Diagnosis pull-forward");
  assert.deepEqual(provenance.target.map((target) => target.reference), [
    conditionEntry.fullUrl,
    encounterEntry.fullUrl,
    observationEntry.fullUrl,
    "Patient/patient-1",
  ]);
  assert.deepEqual(provenance.entity?.map((entity) => entity.what.reference), [
    "Condition/source-dry-eye-od",
    "Observation/source-staining-present",
    "Observation/source-filaments-absent",
    "Observation/source-legacy-no-boolean",
  ]);
  assert.deepEqual(provenance.agent.map((agent) => agent.who.reference), ["Practitioner/doc"]);

  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.conditionReference, "Condition/pulled-condition");
  assert.equal(body.alreadyPresent, false);
  assert.equal((body.transaction as Bundle).type, "transaction-response");
});

test("pull puts the optimistic Encounter version guard before every transaction create", async (t) => {
  const fhir = pullFhir();
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 200, await response.clone().text());
  const entries = fhir.transactions[0]?.bundle.entry ?? [];
  assert.deepEqual(
    entries.map((entry) => [entry.resource?.resourceType, entry.request?.method]),
    [
      ["Encounter", "PUT"],
      ["Condition", "POST"],
      ["Observation", "POST"],
      ["Provenance", "POST"],
    ],
  );
  assert.equal(entries[0]?.request?.ifMatch, 'W/"7"');
  assert.equal(entries.slice(1).every((entry) => entry.request?.method === "POST"), true);
});

test("all-success pull accepts representation-free create locations and an update without a location", async (t) => {
  const fhir = pullFhir();
  fhir.transactionResponseMutator = (response) => {
    const changed = structuredClone(response);
    changed.entry?.forEach((entry, index) => {
      if (index === 0) {
        delete entry.resource;
        entry.response = { status: "200 OK" };
        return;
      }
      assert.ok(entry.resource?.id);
      entry.response = {
        status: "201 Created",
        location: `${entry.resource.resourceType}/${entry.resource.id}/_history/1`,
      };
      delete entry.resource;
    });
    return changed;
  };
  const rollback = new MemoryRollbackFhir([
    "Condition/pulled-condition",
    "Observation/pulled-observation",
    "Provenance/pulled-provenance",
  ]);
  const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json() as { conditionReference?: string }).conditionReference, "Condition/pulled-condition");
  assert.equal(rollback.transactions.length, 0);
});

test("mixed conflict rolls back representation-free creates by their exact locations", async (t) => {
  const fhir = pullFhir();
  fhir.transactionResponseMutator = (response) => {
    const changed = mixedConflictTransactionResponse(response);
    changed.entry?.forEach((entry) => delete entry.resource);
    return changed;
  };
  const rollback = new MemoryRollbackFhir([
    "Condition/pulled-condition",
    "Observation/pulled-observation",
    "Provenance/pulled-provenance",
  ]);
  const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(rollback.transactions.length, 1);
  assert.deepEqual(rollback.transactions[0]?.entry?.map((entry) => entry.request), [
    { method: "DELETE", url: "Provenance/pulled-provenance" },
    { method: "DELETE", url: "Observation/pulled-observation" },
    { method: "DELETE", url: "Condition/pulled-condition" },
  ]);
  assert.deepEqual([...rollback.readReferences].sort(), [
    "Condition/pulled-condition",
    "Observation/pulled-observation",
    "Provenance/pulled-provenance",
  ]);
});

test("representation-free 201 without a parseable location fails without privileged rollback", async (t) => {
  const fhir = pullFhir();
  fhir.transactionResponseMutator = (response) => {
    const changed = mixedConflictTransactionResponse(response);
    changed.entry?.forEach((entry) => delete entry.resource);
    delete changed.entry?.[1]?.response?.location;
    return changed;
  };
  const rollback = new MemoryRollbackFhir([
    "Condition/pulled-condition",
    "Observation/pulled-observation",
    "Provenance/pulled-provenance",
  ]);
  const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 502, await response.clone().text());
  assert.equal(rollback.transactions.length, 0);
});

test("representation-free 201 with the wrong positional location type fails without privileged rollback", async (t) => {
  const fhir = pullFhir();
  fhir.transactionResponseMutator = (response) => {
    const changed = mixedConflictTransactionResponse(response);
    changed.entry?.forEach((entry) => delete entry.resource);
    changed.entry![1]!.response!.location = "Observation/pulled-condition/_history/1";
    return changed;
  };
  const rollback = new MemoryRollbackFhir([
    "Condition/pulled-condition",
    "Observation/pulled-observation",
    "Provenance/pulled-provenance",
  ]);
  const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 502, await response.clone().text());
  assert.equal(rollback.transactions.length, 0);
});

test("represented 201 with a mismatched location id still refuses privileged rollback", async (t) => {
  const fhir = pullFhir();
  fhir.transactionResponseMutator = (response) => {
    const changed = mixedConflictTransactionResponse(response);
    changed.entry![1]!.resource!.id = "different-condition-id";
    return changed;
  };
  const rollback = new MemoryRollbackFhir([
    "Condition/pulled-condition",
    "Observation/pulled-observation",
    "Provenance/pulled-provenance",
  ]);
  const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 502, await response.clone().text());
  assert.equal(rollback.transactions.length, 0);
});

test("mixed stale transaction uses only the service rollback for exact generated create locations", async (t) => {
  const fhir = pullFhir();
  fhir.transactionResponseMutator = mixedConflictTransactionResponse;
  const rollback = new MemoryRollbackFhir([
    "Condition/pulled-condition",
    "Observation/pulled-observation",
    "Provenance/pulled-provenance",
  ]);
  const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 409, await response.clone().text());
  assert.deepEqual(fhir.transactions[0]?.options, { autoRollbackCreatedEntries: false });
  assert.equal(rollback.transactions.length, 1);
  assert.deepEqual(rollback.transactions[0]?.entry?.map((entry) => entry.request), [
    { method: "DELETE", url: "Provenance/pulled-provenance" },
    { method: "DELETE", url: "Observation/pulled-observation" },
    { method: "DELETE", url: "Condition/pulled-condition" },
  ]);
  assert.equal(rollback.readReferences.has("Encounter/current-pull"), false);
  assert.deepEqual([...rollback.remaining], []);
});

test("mixed 409 transaction also authorizes only the exact generated create rollback", async (t) => {
  const fhir = pullFhir();
  fhir.transactionResponseMutator = (response) => {
    const changed = mixedConflictTransactionResponse(response);
    changed.entry![0]!.response!.status = "409 Conflict";
    return changed;
  };
  const rollback = new MemoryRollbackFhir([
    "Condition/pulled-condition",
    "Observation/pulled-observation",
    "Provenance/pulled-provenance",
  ]);
  const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(rollback.transactions.length, 1);
  assert.deepEqual([...rollback.remaining], []);
});

test("guarded Encounter conflict compensates only validated creates around a later POST failure", async (t) => {
  const fhir = pullFhir();
  fhir.transactionResponseMutator = (response) => {
    const changed = mixedConflictTransactionResponse(response);
    changed.entry![2]!.response!.status = "500 Internal Server Error";
    return changed;
  };
  const rollback = new MemoryRollbackFhir([
    "Condition/pulled-condition",
    "Provenance/pulled-provenance",
  ]);
  const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 502, await response.clone().text());
  assert.deepEqual(rollback.transactions[0]?.entry?.map((entry) => entry.request), [
    { method: "DELETE", url: "Provenance/pulled-provenance" },
    { method: "DELETE", url: "Condition/pulled-condition" },
  ]);
  assert.deepEqual([...rollback.remaining], []);
});

for (const mutation of [
  "same-type-wrong-id",
  "non-mixed-invalid",
  "wrong-full-url",
  "wrong-response-order",
  "wrong-location-id",
  "invalid-fhir-id",
  "invalid-http-status",
  "encounter-200-before-later-500",
  "encounter-201-before-later-500",
  "encounter-1xx-before-later-500",
  "encounter-500",
  "later-1xx",
  "later-3xx",
  "later-missing-status",
  "later-malformed-status",
] as const) {
  test(`mixed transaction makes zero service rollback calls for ${mutation}`, async (t) => {
    const fhir = pullFhir();
    if (mutation === "wrong-full-url") {
      fhir.transactionRequestMutator = (request) => {
        request.entry![1]!.fullUrl = "urn:uuid:not-a-generated-uuid";
      };
    }
    fhir.transactionResponseMutator = (response) => {
      const changed = mixedConflictTransactionResponse(response);
      if (mutation === "same-type-wrong-id") {
        changed.entry![1]!.resource!.id = "different-condition-id";
      } else if (mutation === "non-mixed-invalid") {
        changed.type = "batch-response";
        changed.entry![0]!.response!.status = "200 OK";
      } else if (mutation === "wrong-response-order") {
        [changed.entry![1], changed.entry![2]] = [changed.entry![2]!, changed.entry![1]!];
      } else if (mutation === "wrong-location-id") {
        changed.entry![1]!.response!.location = "Condition/different-condition-id/_history/1";
      } else if (mutation === "invalid-fhir-id") {
        changed.entry![1]!.resource!.id = "invalid$id";
        changed.entry![1]!.response!.location = "Condition/invalid$id/_history/1";
      } else if (mutation === "invalid-http-status") {
        changed.entry![0]!.response!.status = "999 Not HTTP";
      } else if (mutation === "encounter-200-before-later-500") {
        changed.entry![0]!.response!.status = "200 OK";
        changed.entry![2]!.response!.status = "500 Internal Server Error";
      } else if (mutation === "encounter-201-before-later-500") {
        changed.entry![0]!.response!.status = "201 Created";
        changed.entry![2]!.response!.status = "500 Internal Server Error";
      } else if (mutation === "encounter-1xx-before-later-500") {
        changed.entry![0]!.response!.status = "102 Processing";
        changed.entry![2]!.response!.status = "500 Internal Server Error";
      } else if (mutation === "encounter-500") {
        changed.entry![0]!.response!.status = "500 Internal Server Error";
      } else if (mutation === "later-1xx") {
        changed.entry![2]!.response!.status = "102 Processing";
      } else if (mutation === "later-3xx") {
        changed.entry![2]!.response!.status = "302 Found";
      } else if (mutation === "later-missing-status") {
        delete changed.entry![2]!.response!.status;
      } else if (mutation === "later-malformed-status") {
        changed.entry![2]!.response!.status = "not-an-http-status";
      }
      return changed;
    };
    const rollback = new MemoryRollbackFhir([
      "Condition/pulled-condition",
      "Observation/pulled-observation",
      "Provenance/pulled-provenance",
    ]);
    const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

    const response = await postPull(base, "source-dry-eye-od");

    assert.equal(response.status, 502, `${mutation}: ${await response.clone().text()}`);
    assert.equal(rollback.transactions.length, 0, mutation);
  });
}

test("mixed stale transaction fails closed when privileged rollback is absent", async (t) => {
  const fhir = pullFhir();
  fhir.transactionResponseMutator = mixedConflictTransactionResponse;
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 502, await response.clone().text());
});

for (const mutation of ["wrong-location-type", "delete-failure", "still-readable"] as const) {
  test(`mixed stale transaction fails closed for ${mutation} rollback evidence`, async (t) => {
    const fhir = pullFhir();
    fhir.transactionResponseMutator = (response) => {
      const changed = mixedConflictTransactionResponse(response);
      if (mutation === "wrong-location-type") {
        changed.entry![1]!.response!.location = "Patient/not-a-generated-condition/_history/1";
      }
      return changed;
    };
    const rollback = new MemoryRollbackFhir([
      "Condition/pulled-condition",
      "Observation/pulled-observation",
      "Provenance/pulled-provenance",
    ]);
    rollback.failDelete = mutation === "delete-failure";
    rollback.keepReadable = mutation === "still-readable";
    const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

    const response = await postPull(base, "source-dry-eye-od");

    assert.equal(response.status, 502, `${mutation}: ${await response.clone().text()}`);
    if (mutation === "wrong-location-type") assert.equal(rollback.transactions.length, 0);
  });
}

for (const status of ["201 Created", "202 Accepted", "206 Partial Content", "226 IM Used"] as const) {
  test(`mixed stale transaction rejects rollback DELETE status ${status}`, async (t) => {
    const fhir = pullFhir();
    fhir.transactionResponseMutator = mixedConflictTransactionResponse;
    const rollback = new MemoryRollbackFhir([
      "Condition/pulled-condition",
      "Observation/pulled-observation",
      "Provenance/pulled-provenance",
    ]);
    rollback.deleteStatus = status;
    const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

    const response = await postPull(base, "source-dry-eye-od");

    assert.equal(response.status, 502, `${status}: ${await response.clone().text()}`);
  });
}

test("mixed stale transaction rejects message-only 404 rollback verification", async (t) => {
  const fhir = pullFhir();
  fhir.transactionResponseMutator = mixedConflictTransactionResponse;
  const rollback = new MemoryRollbackFhir([
    "Condition/pulled-condition",
    "Observation/pulled-observation",
    "Provenance/pulled-provenance",
  ]);
  rollback.readError = new Error("FHIR 404 synthetic message without numeric status");
  const base = await startPreviousExamRoutes(t, fhir, "auditor", rollback);

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 502, await response.clone().text());
});

test("pull re-read catches a raced exact OD diagnosis and returns its current reference without a transaction", async (t) => {
  const fhir = pullFhir();
  fhir.beforeCurrentEncounterRead = (readNumber) => {
    if (readNumber !== 2) return;
    const concurrent = diagnosis("concurrent-dry-eye-od", "current-pull", "dry_eye", "right", "confirmed", []);
    concurrent.code = { text: "Keratoconjunctivitis sicca, right eye" };
    concurrent.extension = [{
      url: ODOS_EXTENSION_URLS.eyeLaterality,
      valueCodeableConcept: lateralityConcept("OD"),
    }];
    fhir.resources.push(concurrent);
    const encounterResource = fhir.resource<Encounter>("Encounter", "current-pull");
    encounterResource.diagnosis = [
      ...(encounterResource.diagnosis ?? []),
      buildEncounterDiagnosisComponent("Condition/concurrent-dry-eye-od", 5),
    ];
    encounterResource.meta = { versionId: "8" };
  };
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    conditionReference: "Condition/concurrent-dry-eye-od",
    alreadyPresent: true,
  });
  assert.equal(fhir.transactions.length, 0);
});

test("pull does not treat an existing OD diagnosis as the requested OS identity", async (t) => {
  const fhir = pullFhir("source-dry-eye-os");
  const currentOd = diagnosis("current-dry-eye-od", "current-pull", "dry_eye", "right", "confirmed", []);
  currentOd.code = structuredClone(fhir.resource<Condition>("Condition", "source-dry-eye-os").code);
  fhir.resources.push(currentOd);
  fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
    buildEncounterDiagnosisComponent("Condition/current-dry-eye-od", 5),
  );
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-os");

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json() as { alreadyPresent: boolean }).alreadyPresent, false);
  assert.equal(fhir.transactions.length, 1);
});

test("pull ignores a matching Condition that does not belong to the current Encounter", async (t) => {
  const fhir = pullFhir();
  const foreign = diagnosis("foreign-dry-eye-od", "current-pull", "dry_eye", "right", "confirmed", []);
  foreign.encounter = { reference: "Encounter/other" };
  foreign.extension = [{
    url: ODOS_EXTENSION_URLS.eyeLaterality,
    valueCodeableConcept: lateralityConcept("OD"),
  }];
  fhir.resources.push(foreign);
  fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
    buildEncounterDiagnosisComponent("Condition/foreign-dry-eye-od", 5),
  );
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json() as { alreadyPresent: boolean }).alreadyPresent, false);
  assert.equal(fhir.transactions.length, 1);
});

test("pull treats a catalog stable key and recorded laterality as identity despite changed literal coding and text", async (t) => {
  const fhir = pullFhir();
  const differentLiteral = diagnosis(
    "current-dry-eye-different-literal",
    "current-pull",
    "dry_eye",
    "right",
    "confirmed",
    [],
  );
  differentLiteral.code = { text: "Different literal recorded diagnosis" };
  differentLiteral.extension = [{
    url: ODOS_EXTENSION_URLS.eyeLaterality,
    valueCodeableConcept: lateralityConcept("OD"),
  }];
  fhir.resources.push(differentLiteral);
  fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
    buildEncounterDiagnosisComponent("Condition/current-dry-eye-different-literal", 5),
  );
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    conditionReference: "Condition/current-dry-eye-different-literal",
    alreadyPresent: true,
  });
  assert.equal(fhir.transactions.length, 0);
});

test("pull matches uncataloged literal coding text and laterality without a terminology mapping", async (t) => {
  const fhir = pullFhir("source-uncataloged");
  const source = fhir.resource<Condition>("Condition", "source-uncataloged");
  const current: Condition = {
    ...structuredClone(source),
    id: "current-uncataloged",
    encounter: { reference: "Encounter/current-pull" },
    code: {
      coding: [...(source.code?.coding ?? [])].reverse(),
      text: source.code?.text,
    },
  };
  fhir.resources.push(current);
  fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
    buildEncounterDiagnosisComponent("Condition/current-uncataloged", 5),
  );
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-uncataloged");

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    conditionReference: "Condition/current-uncataloged",
    alreadyPresent: true,
  });
  assert.equal(fhir.transactions.length, 0);
});

test("pull keeps uncataloged diagnoses distinct when their literal text differs", async (t) => {
  const fhir = pullFhir("source-uncataloged");
  const source = fhir.resource<Condition>("Condition", "source-uncataloged");
  const current: Condition = {
    ...structuredClone(source),
    id: "current-uncataloged-different-text",
    encounter: { reference: "Encounter/current-pull" },
    code: { ...structuredClone(source.code!), text: "A different uncataloged literal" },
  };
  fhir.resources.push(current);
  fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
    buildEncounterDiagnosisComponent("Condition/current-uncataloged-different-text", 5),
  );

  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-uncataloged");

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json() as { alreadyPresent: boolean }).alreadyPresent, false);
  assert.equal(fhir.transactions.length, 1);
});

test("pull uses the recorded Condition bodySite instead of a stale catalog identifier laterality", async (t) => {
  const fhir = pullFhir("source-dry-eye-os");
  const current = diagnosis("current-stale-catalog-laterality", "current-pull", "dry_eye", "right", "confirmed", []);
  current.bodySite = [{ text: "OS" }];
  fhir.resources.push(current);
  fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
    buildEncounterDiagnosisComponent("Condition/current-stale-catalog-laterality", 5),
  );

  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-os");

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    conditionReference: "Condition/current-stale-catalog-laterality",
    alreadyPresent: true,
  });
  assert.equal(fhir.transactions.length, 0);
});

test("pull rejects source Encounters that are not strictly prior full instants", async (t) => {
  for (const [name, start] of [
    ["future", "2026-09-10T09:00:00.000Z"],
    ["equal", "2026-08-10T09:00:00.000Z"],
    ["missing", undefined],
    ["invalid", "2026-08-10"],
  ] as const) {
    const fhir = pullFhir();
    const source = fhir.resource<Encounter>("Encounter", "source-pull");
    source.period = start === undefined ? undefined : { start };

    const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");

    assert.equal(response.status, 409, `${name}: ${await response.text()}`);
    assert.equal(fhir.transactions.length, 0, name);
  }
});

test("pull rejects a current Encounter without a valid full start instant before a transaction", async (t) => {
  for (const [name, start] of [["missing", undefined], ["invalid", "2026-08-10"]] as const) {
    const fhir = pullFhir();
    const current = fhir.resource<Encounter>("Encounter", "current-pull");
    current.period = start === undefined ? undefined : { start };

    const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");

    assert.equal(response.status, 409, `${name}: ${await response.text()}`);
    assert.equal(fhir.transactions.length, 0, name);
  }
});

test("pull rechecks the current Encounter start instant immediately before idempotency and the transaction", async (t) => {
  for (const [name, start] of [["equal", "2026-07-10T09:00:00.000Z"], ["invalid", "not-an-instant"]] as const) {
    const fhir = pullFhir();
    fhir.beforeCurrentEncounterRead = (readNumber) => {
      if (readNumber === 2) fhir.resource<Encounter>("Encounter", "current-pull").period = { start };
    };

    const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");

    assert.equal(response.status, 409, `${name}: ${await response.text()}`);
    assert.equal(fhir.transactions.length, 0, name);
  }
});

test("pull rejects source patient, diagnosis membership, and retracted-condition boundary failures", async (t) => {
  for (const boundary of ["patient", "membership", "retracted"] as const) {
    const fhir = pullFhir();
    if (boundary === "patient") {
      fhir.resource<Condition>("Condition", "source-dry-eye-od").subject.reference = "Patient/other";
    } else if (boundary === "membership") {
      fhir.resource<Encounter>("Encounter", "source-pull").diagnosis = [];
    } else {
      fhir.resource<Condition>("Condition", "source-dry-eye-od").verificationStatus = {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "refuted" }],
      };
    }
    const base = await startPreviousExamRoutes(t, fhir, "auditor");

    const response = await postPull(base, "source-dry-eye-od");

    assert.equal(response.status, 409, `${boundary}: ${await response.text()}`);
    assert.equal(fhir.transactions.length, 0);
  }
});

test("pull rejects failed transaction entries and maps precondition failures to 409", async (t) => {
  for (const failureStatus of ["412 Precondition Failed", "500 Internal Server Error"] as const) {
    const fhir = pullFhir();
    fhir.transactionFailureStatus = failureStatus;
    const base = await startPreviousExamRoutes(t, fhir, "auditor");

    const response = await postPull(base, "source-dry-eye-od");

    assert.equal(response.status, failureStatus.startsWith("412") ? 409 : 502, await response.text());
    assert.equal(fhir.transactions.length, 1);
  }
});

for (const malformed of [
  {
    name: "a non-Bundle resource discriminator",
    mutate: (response: Bundle) => ({
      ...response,
      resourceType: "OperationOutcome",
    }) as unknown as Bundle,
  },
  {
    name: "a non-transaction-response Bundle",
    mutate: (response: Bundle) => ({ ...response, type: "batch-response" as Bundle["type"] }),
  },
  {
    name: "a truncated transaction response",
    mutate: (response: Bundle) => ({ ...response, entry: response.entry?.slice(0, -1) }),
  },
  {
    name: "a transaction entry without status",
    mutate: (response: Bundle) => {
      const changed = structuredClone(response);
      delete changed.entry?.[1]?.response?.status;
      return changed;
    },
  },
  {
    name: "a 3xx transaction entry",
    mutate: (response: Bundle) => {
      const changed = structuredClone(response);
      changed.entry![1]!.response!.status = "302 Found";
      return changed;
    },
  },
  {
    name: "transaction entries in the wrong resource order",
    mutate: (response: Bundle) => {
      const changed = structuredClone(response);
      [changed.entry![2], changed.entry![3]] = [changed.entry![3]!, changed.entry![2]!];
      return changed;
    },
  },
] as const) {
  test(`pull rejects ${malformed.name}`, async (t) => {
    const fhir = pullFhir();
    fhir.transactionResponseMutator = malformed.mutate;
    const base = await startPreviousExamRoutes(t, fhir, "auditor");

    const response = await postPull(base, "source-dry-eye-od");

    assert.equal(response.status, 502, await response.text());
    assert.equal(fhir.transactions.length, 1);
  });
}

for (const missing of [
  { name: "current Encounter", reference: "Encounter/current-pull" },
  { name: "source Encounter", reference: "Encounter/source-pull" },
  { name: "source Condition", reference: "Condition/source-dry-eye-od" },
] as const) {
  test(`pull maps a missing ${missing.name} to a non-leaking 404`, async (t) => {
    const fhir = pullFhir();
    fhir.remove(missing.reference);
    const base = await startPreviousExamRoutes(t, fhir, "auditor");

    const response = await postPull(base, "source-dry-eye-od");

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Diagnosis pull resources were not found." });
    assert.equal(fhir.transactions.length, 0);
  });
}

test("pull maps a patient-compartment source read denial to a non-leaking 403", async (t) => {
  const fhir = pullFhir();
  fhir.readFailures.set("Condition/source-dry-eye-od", 403);
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Diagnosis pull resources are outside the caller's patient compartment.",
  });
  assert.equal(fhir.transactions.length, 0);
});

test("pull maps a missing source evidence Observation to a non-leaking 404", async (t) => {
  const fhir = pullFhir();
  fhir.readFailures.set("Observation/source-staining-present", 404);
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Diagnosis pull resources were not found." });
  assert.equal(fhir.transactions.length, 0);
});

test("pull maps a gone source Condition to the same non-leaking 404", async (t) => {
  const fhir = pullFhir();
  fhir.readFailures.set("Condition/source-dry-eye-od", 410);
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Diagnosis pull resources were not found." });
  assert.equal(fhir.transactions.length, 0);
});

test("pull maps a current-identity Condition compartment denial to a non-leaking 403", async (t) => {
  const fhir = pullFhir();
  fhir.readFailures.set("Condition/current-other-1", 403);
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Diagnosis pull resources are outside the caller's patient compartment.",
  });
  assert.equal(fhir.transactions.length, 0);
});

test("pull rejects a source Encounter for another patient", async (t) => {
  const fhir = pullFhir();
  fhir.resource<Encounter>("Encounter", "source-pull").subject = { reference: "Patient/other" };
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 0);
});

test("pull rejects a source Condition declaring another Encounter", async (t) => {
  const fhir = pullFhir();
  fhir.resource<Condition>("Condition", "source-dry-eye-od").encounter = { reference: "Encounter/other" };
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 0);
});

test("pull rejects source evidence for another patient", async (t) => {
  const fhir = pullFhir();
  fhir.resource<Observation>("Observation", "source-staining-present").subject = { reference: "Patient/other" };
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 0);
});

test("pull rejects source evidence declaring another Encounter", async (t) => {
  const fhir = pullFhir();
  fhir.resource<Observation>("Observation", "source-staining-present").encounter = { reference: "Encounter/other" };
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 0);
});

test("pull rejects an entered-in-error source Condition", async (t) => {
  const fhir = pullFhir();
  fhir.resource<Condition>("Condition", "source-dry-eye-od").verificationStatus = {
    coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "entered-in-error" }],
  };
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 0);
});

test("pull excludes an entered-in-error source Observation", async (t) => {
  const fhir = pullFhir();
  fhir.resource<Observation>("Observation", "source-staining-present").status = "entered-in-error";
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 200, await response.clone().text());
  const transaction = fhir.transactions[0]!.bundle;
  assert.deepEqual(transaction.entry?.map((entry) => entry.resource?.resourceType), [
    "Encounter",
    "Condition",
    "Provenance",
  ]);
  assert.deepEqual((transaction.entry?.[1]?.resource as Condition).evidence, undefined);
  assert.equal(JSON.stringify(transaction.entry?.at(-1)?.resource).includes("source-staining-present"), false);
});

test("pull rejects an entered-in-error source Encounter", async (t) => {
  const fhir = pullFhir();
  fhir.resource<Encounter>("Encounter", "source-pull").status = "entered-in-error";
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 0);
});

test("pull rejects an entered-in-error current Encounter", async (t) => {
  const fhir = pullFhir();
  fhir.resource<Encounter>("Encounter", "current-pull").status = "entered-in-error";
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 0);
});

test("pull rejects a current Encounter entering error on the mutation-time re-read", async (t) => {
  const fhir = pullFhir();
  fhir.beforeCurrentEncounterRead = (readNumber) => {
    if (readNumber === 2) {
      fhir.resource<Encounter>("Encounter", "current-pull").status = "entered-in-error";
    }
  };
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 0);
});

test("pull rejects a current patient change on the mutation-time re-read", async (t) => {
  const fhir = pullFhir();
  fhir.beforeCurrentEncounterRead = (readNumber) => {
    if (readNumber === 2) {
      fhir.resource<Encounter>("Encounter", "current-pull").subject = { reference: "Patient/other" };
    }
  };
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 0);
});

test("pull rejects a current Encounter without a version", async (t) => {
  const fhir = pullFhir();
  delete fhir.resource<Encounter>("Encounter", "current-pull").meta;
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 0);
});

test("a repeated exact pull returns the current Condition without a transaction", async (t) => {
  const fhir = pullFhir();
  const current = diagnosis("current-existing-dry-eye-od", "current-pull", "dry_eye", "right", "confirmed", []);
  current.extension = structuredClone(fhir.resource<Condition>("Condition", "source-dry-eye-od").extension);
  fhir.resources.push(current);
  fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
    buildEncounterDiagnosisComponent("Condition/current-existing-dry-eye-od", 5),
  );
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    conditionReference: "Condition/current-existing-dry-eye-od",
    alreadyPresent: true,
  });
  assert.equal(fhir.transactions.length, 0);
});

test("a transaction conflict re-read returns the concurrently created exact Condition", async (t) => {
  const fhir = pullFhir();
  fhir.transactionErrorStatus = 412;
  fhir.beforeTransaction = () => {
    const current = diagnosis("current-conflict-dry-eye-od", "current-pull", "dry_eye", "right", "confirmed", []);
    current.extension = structuredClone(fhir.resource<Condition>("Condition", "source-dry-eye-od").extension);
    fhir.resources.push(current);
    fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
      buildEncounterDiagnosisComponent("Condition/current-conflict-dry-eye-od", 5),
    );
  };
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    conditionReference: "Condition/current-conflict-dry-eye-od",
    alreadyPresent: true,
  });
  assert.equal(fhir.transactions.length, 1);
});

test("a transaction conflict without the exact identity returns 409", async (t) => {
  const fhir = pullFhir();
  fhir.transactionErrorStatus = 412;
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 1);
});

test("a transaction conflict whose current Encounter disappeared returns 409", async (t) => {
  const fhir = pullFhir();
  fhir.transactionErrorStatus = 412;
  fhir.beforeTransaction = () => fhir.remove("Encounter/current-pull");
  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");
  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 1);
});

test("a conflict reread never returns an exact diagnosis from an entered-in-error current Encounter", async (t) => {
  const fhir = pullFhir();
  fhir.transactionErrorStatus = 412;
  fhir.beforeTransaction = () => {
    const current = diagnosis("current-conflict-entered-error", "current-pull", "dry_eye", "right", "confirmed", []);
    current.extension = structuredClone(fhir.resource<Condition>("Condition", "source-dry-eye-od").extension);
    fhir.resources.push(current);
    fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
      buildEncounterDiagnosisComponent("Condition/current-conflict-entered-error", 5),
    );
  };
  fhir.beforeCurrentEncounterRead = (readNumber) => {
    if (readNumber === 3) {
      fhir.resource<Encounter>("Encounter", "current-pull").status = "entered-in-error";
    }
  };

  const response = await postPull(await startPreviousExamRoutes(t, fhir, "auditor"), "source-dry-eye-od");

  assert.equal(response.status, 409, await response.text());
  assert.equal(fhir.transactions.length, 1);
});

test("live ordinary-clinician policy persists and reads diagnosis carry while preserving atomic conflict rollback", { timeout: 90_000 }, async (t) => {
  loadRepoEnv();
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) {
    t.skip("MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for the diagnosis pull integration proof.");
    return;
  }

  const { fhir: adminFhir, accessToken: adminAccessToken } = await createAuthenticatedFhirClient({ baseUrl, email, password });
  const runId = randomUUID();
  const system = "urn:odos:test:diagnosis-carry-forward";
  const clientName = `diagnosis-carry-clinician-${runId}`;
  const accessPolicyName = `ODOS diagnosis carry clinician proof ${runId}`;
  const cleanupReferences = new Set<string>();
  const sweepEncounterIds = new Set<string>();
  let projectId: string | undefined;
  let clientApplicationId: string | undefined;
  let accessPolicyId: string | undefined;
  const track = <T extends Resource>(resource: T): T => {
    assert.ok(resource.id, `Expected created ${resource.resourceType} to have an id.`);
    cleanupReferences.add(`${resource.resourceType}/${resource.id}`);
    return resource;
  };

  await runProofWithCleanup(async () => {
    const practitioner = track(await adminFhir.create<Practitioner>({
      resourceType: "Practitioner",
      identifier: [{ system, value: `practitioner-${runId}` }],
      name: [{ family: `DiagnosisPull${runId}`, given: ["Synthetic"] }],
    }));
    const patient = track(await adminFhir.create<Patient>({
      resourceType: "Patient",
      identifier: [{ system, value: `patient-${runId}` }],
      name: [{ family: `DiagnosisPull${runId}`, given: ["Synthetic"] }],
      generalPractitioner: [{ reference: `Practitioner/${practitioner.id}` }],
    }));
    const patientReference = `Patient/${patient.id}`;
    const sourceEncounter = track(await adminFhir.create<Encounter>(syntheticEncounter(patientReference, system, `source-${runId}`)));
    const currentEncounter = track(await adminFhir.create<Encounter>(syntheticEncounter(patientReference, system, `current-${runId}`)));
    sweepEncounterIds.add(currentEncounter.id!);
    const present = track(await adminFhir.create<Observation>(
      syntheticEvidence(patientReference, `Encounter/${sourceEncounter.id}`, system, `present-${runId}`, true),
    ));
    const absent = track(await adminFhir.create<Observation>(
      syntheticEvidence(patientReference, `Encounter/${sourceEncounter.id}`, system, `absent-${runId}`, false),
    ));
    const sourceCondition = track(await adminFhir.create<Condition>({
      ...buildEncounterDiagnosisCondition({
        patientReference,
        encounterReference: `Encounter/${sourceEncounter.id}`,
        code: { coding: [{ system, code: `diagnosis-${runId}` }], text: `Synthetic diagnosis ${runId}` },
        verificationStatus: "confirmed",
        identifiers: [{
          system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
          value: `${sourceEncounter.id}::synthetic_${runId}::right`,
        }],
        evidenceObservationReferences: [`Observation/${present.id}`, `Observation/${absent.id}`],
      }),
      extension: [{ url: ODOS_EXTENSION_URLS.eyeLaterality, valueCodeableConcept: lateralityConcept("OD") }],
    }));
    await adminFhir.update<Encounter>("Encounter", sourceEncounter.id!, {
      ...sourceEncounter,
      diagnosis: [buildEncounterDiagnosisComponent(`Condition/${sourceCondition.id}`, 1)],
    });

    const clinicianPolicy = buildMedplumAccessPolicy(getRoleDeclaration("clinician"));
    clinicianPolicy.name = accessPolicyName;
    const createdPolicy = track(await adminFhir.create<AccessPolicy>(clinicianPolicy));
    accessPolicyId = createdPolicy.id;
    projectId = await activeProjectId(baseUrl, adminAccessToken);
    const clientApplication = await createDisposableClientApplication(
      baseUrl,
      adminAccessToken,
      projectId,
      `AccessPolicy/${createdPolicy.id}`,
      clientName,
      (id) => {
        clientApplicationId = id;
        cleanupReferences.add(`ClientApplication/${id}`);
      },
    );
    const memberships = (await searchAll<ProjectMembership>(adminFhir, "ProjectMembership", {
      profile: `ClientApplication/${clientApplication.id}`,
    })).filter((membership) => membership.project.reference === `Project/${projectId}`);
    assert.equal(memberships.length, 1, "Disposable client must have one membership in the existing local project.");
    const membership = memberships[0]!;
    assert.ok(membership.id && membership.meta?.versionId);
    cleanupReferences.add(`ProjectMembership/${membership.id}`);
    await adminFhir.patch<ProjectMembership>("ProjectMembership", membership.id, [{
      op: membership.access?.length ? "replace" : "add",
      path: "/access",
      value: buildProjectMembershipAccess({
        policyReference: `AccessPolicy/${createdPolicy.id}`,
        parameters: {
          providerProfileReference: `Practitioner/${practitioner.id}`,
          patientCompartmentReference: patientReference,
        },
      }),
    }], { "If-Match": `W/\"${membership.meta.versionId}\"` });
    const clinicianToken = await clientCredentialsToken(
      baseUrl,
      clientApplication.id,
      clientApplication.secret,
    );
    const policyProbe = await fetch(`${baseUrl.replace(/\/$/, "")}/fhir/R4/AccessPolicy?_count=1`, {
      headers: { Authorization: `Bearer ${clinicianToken}` },
    });
    assert.equal(policyProbe.status, 403, "Ordinary clinician proof token must not have admin AccessPolicy reach.");
    const clinicianFhir = createMedplumClient({
      baseUrl,
      accessToken: clinicianToken,
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });
    const authenticate = async () => ({
      staffReference: `Practitioner/${practitioner.id}`,
      actorRole: "clinician" as const,
      fhir: clinicianFhir,
    });
    const result = await handleDiagnosisPullRequest({ fhirBaseUrl: baseUrl, authenticate }, {
      authHeader: "Bearer synthetic-live-proof",
      params: { encounterId: currentEncounter.id },
      body: {
        sourceEncounterReference: `Encounter/${sourceEncounter.id}`,
        sourceConditionReference: `Condition/${sourceCondition.id}`,
      },
    });
    const successfulBody = result.body as { conditionReference: string; transaction: Bundle };
    captureTransactionResponseReferences(successfulBody.transaction, cleanupReferences);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(successfulBody.transaction.type, "transaction-response");
    assert.equal(successfulBody.transaction.entry?.length, 4);
    assert.ok(successfulBody.transaction.entry?.every((entry) => entry.response?.status?.match(/^2\d\d(?:\s|$)/)));
    const pulledConditionId = successfulBody.conditionReference.split("/")[1]!;
    const persistedCondition = await clinicianFhir.read<Condition>("Condition", pulledConditionId);
    const persistedEncounter = await clinicianFhir.read<Encounter>("Encounter", currentEncounter.id!);
    const persistedObservation = successfulBody.transaction.entry?.find((entry) =>
      entry.resource?.resourceType === "Observation"
    )?.resource as Observation | undefined;
    const persistedProvenance = successfulBody.transaction.entry?.find((entry) =>
      entry.resource?.resourceType === "Provenance"
    )?.resource as Provenance | undefined;
    assert.ok(persistedObservation?.id);
    assert.ok(persistedProvenance?.id);
    const reloadedObservation = await clinicianFhir.read<Observation>("Observation", persistedObservation.id);
    const reloadedProvenance = await clinicianFhir.read<Provenance>("Provenance", persistedProvenance.id);
    assert.equal(persistedCondition.encounter?.reference, `Encounter/${currentEncounter.id}`);
    assert.equal(persistedCondition.verificationStatus?.coding?.[0]?.code, "confirmed");
    assert.deepEqual(persistedCondition.evidence?.[0]?.detail?.map((detail) => detail.reference), [
      `Observation/${persistedObservation.id}`,
    ]);
    assert.equal(persistedEncounter.diagnosis?.at(-1)?.condition.reference, `Condition/${persistedCondition.id}`);
    assert.equal(reloadedObservation.status, "preliminary");
    assert.equal(reloadedObservation.valueBoolean, true);
    assert.equal(reloadedObservation.focus, undefined);
    assert.equal(reloadedProvenance.activity?.text, "Diagnosis pull-forward");
    assert.deepEqual(reloadedProvenance.entity?.map((entity) => entity.what.reference), [
      `Condition/${sourceCondition.id}`,
      `Observation/${present.id}`,
      `Observation/${absent.id}`,
    ]);
    assert.equal(reloadedProvenance.target.some((target) => target.reference === patientReference), true);
    const carryState = await readDiagnosisCarryState(clinicianFhir, persistedCondition, [reloadedObservation]);
    assert.equal(carryState.edited, false, carryState.integrityWarning);
    assert.equal(carryState.pulledFromDate, sourceEncounter.period?.start);

    const conflictSourceEncounter = track(await adminFhir.create<Encounter>(
      syntheticEncounter(patientReference, system, `conflict-source-${runId}`),
    ));
    const conflictCurrentEncounter = track(await adminFhir.create<Encounter>(
      syntheticEncounter(patientReference, system, `conflict-current-${runId}`),
    ));
    sweepEncounterIds.add(conflictCurrentEncounter.id!);
    const conflictEvidence = track(await adminFhir.create<Observation>(syntheticEvidence(
      patientReference,
      `Encounter/${conflictSourceEncounter.id}`,
      system,
      `conflict-present-${runId}`,
      true,
    )));
    const conflictCondition = track(await adminFhir.create<Condition>(buildEncounterDiagnosisCondition({
      patientReference,
      encounterReference: `Encounter/${conflictSourceEncounter.id}`,
      code: { coding: [{ system, code: `conflict-diagnosis-${runId}` }], text: `Conflict diagnosis ${runId}` },
      verificationStatus: "confirmed",
      identifiers: [{
        system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
        value: `${conflictSourceEncounter.id}::conflict_${runId}::left`,
      }],
      evidenceObservationReferences: [`Observation/${conflictEvidence.id}`],
    })));
    await adminFhir.update<Encounter>("Encounter", conflictSourceEncounter.id!, {
      ...conflictSourceEncounter,
      diagnosis: [buildEncounterDiagnosisComponent(`Condition/${conflictCondition.id}`, 1)],
    });

    let injectedConflict = false;
    let conflictResponseSummary: unknown;
    const conflictFhir: DiagnosisCarryForwardFhirClient = {
      read: (resourceType, id) => clinicianFhir.read(resourceType, id),
      search: (resourceType, params) => clinicianFhir.search(resourceType, params),
      searchUrl: (url, resourceType) => clinicianFhir.searchUrl!(url, resourceType),
      executeTransaction: async (bundle, headers, options) => {
        if (!injectedConflict) {
          injectedConflict = true;
          const fresh = await adminFhir.read<Encounter>("Encounter", conflictCurrentEncounter.id!);
          await adminFhir.update<Encounter>("Encounter", conflictCurrentEncounter.id!, {
            ...fresh,
            extension: [...(fresh.extension ?? []), { url: system, valueString: `race-${runId}` }],
          });
        }
        const response = await clinicianFhir.executeTransaction(bundle, headers, options);
        captureTransactionResponseReferences(response, cleanupReferences);
        conflictResponseSummary = {
          type: response.type,
          entries: response.entry?.map((entry) => ({
            status: entry.response?.status,
            resourceType: entry.resource?.resourceType,
            location: entry.response?.location,
          })),
        };
        return response;
      },
    };
    const originalFetch = globalThis.fetch;
    let clinicianDeleteRequests = 0;
    globalThis.fetch = async (input, init) => {
      if (
        init?.method === "DELETE" &&
        new Headers(init.headers).get("authorization") === `Bearer ${clinicianToken}`
      ) {
        clinicianDeleteRequests += 1;
      }
      return originalFetch(input, init);
    };
    let conflictResult: Awaited<ReturnType<typeof handleDiagnosisPullRequest>>;
    try {
      conflictResult = await handleDiagnosisPullRequest({
        fhirBaseUrl: baseUrl,
        rollbackFhir: adminFhir,
        authenticate: async () => ({
          staffReference: `Practitioner/${practitioner.id}`,
          actorRole: "clinician",
          fhir: conflictFhir,
        }),
      }, {
        authHeader: "Bearer synthetic-live-proof",
        params: { encounterId: conflictCurrentEncounter.id },
        body: {
          sourceEncounterReference: `Encounter/${conflictSourceEncounter.id}`,
          sourceConditionReference: `Condition/${conflictCondition.id}`,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(clinicianDeleteRequests, 0, "Ordinary clinician token must never send compensating DELETE.");
    assert.equal(
      conflictResult.status,
      409,
      JSON.stringify({ body: conflictResult.body, transaction: conflictResponseSummary }),
    );
    const rolledBackEncounter = await clinicianFhir.read<Encounter>("Encounter", conflictCurrentEncounter.id!);
    assert.deepEqual(rolledBackEncounter.diagnosis, undefined);
    await assertNoTransactionLeaks(adminFhir, conflictCurrentEncounter.id!, conflictResponseSummary);
  }, async () => {
    await cleanupSyntheticPullProof(
      adminFhir,
      baseUrl,
      adminAccessToken,
      sweepEncounterIds,
      cleanupReferences,
      {
        projectId,
        clientName,
        accessPolicyName,
        knownClientApplicationId: clientApplicationId,
        knownAccessPolicyId: accessPolicyId,
      },
    );
  });
});

test("synthetic cleanup attempts every exact reference and aggregates all failures", async () => {
  const references = new Set(["Condition/one", "Observation/two", "Provenance/three"]);
  const attempted: Array<{ method: string; reference: string }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const reference = String(input).split("/fhir/R4/")[1]!;
    const method = init?.method ?? "GET";
    attempted.push({ method, reference });
    if (method === "DELETE" && reference === "Observation/two") throw new Error("synthetic network failure");
    return new Response(null, {
      status: method === "DELETE" && reference === "Condition/one" ? 500 : method === "DELETE" ? 204 : 404,
    });
  };

  await assert.rejects(
    deleteSyntheticReferences("https://fhir.local", "synthetic-token", references, fakeFetch),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
  assert.deepEqual(attempted, [
    { method: "DELETE", reference: "Provenance/three" },
    { method: "DELETE", reference: "Observation/two" },
    { method: "DELETE", reference: "Condition/one" },
    { method: "GET", reference: "Provenance/three" },
    { method: "GET", reference: "Observation/two" },
    { method: "GET", reference: "Condition/one" },
  ]);
});

test("disposable client creation exposes its id before a later response assertion fails", async () => {
  const originalFetch = globalThis.fetch;
  let persistedClientId: string | undefined;
  globalThis.fetch = async () => Response.json({ id: "client-created-before-failure" }, { status: 201 });
  try {
    await assert.rejects(createDisposableClientApplication(
      "https://fhir.local",
      "synthetic-admin-token",
      "existing-project",
      "AccessPolicy/unique-policy",
      "unique-run",
      (id) => {
        persistedClientId = id;
      },
    ), /response was incomplete/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(persistedClientId, "client-created-before-failure");
});

test("early-failure cleanup rediscovers all unique auth artifacts and verifies every exact deletion", async () => {
  const clientName = "diagnosis-carry-clinician-unique-run";
  const policyName = "ODOS diagnosis carry clinician proof unique-run";
  const fhir = new CleanupDiscoveryFhir(clientName, policyName);
  const references = new Set<string>();
  const calls: Array<{ method: string; reference: string }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const reference = String(input).split("/fhir/R4/")[1]!;
    const method = init?.method ?? "GET";
    calls.push({ method, reference });
    return new Response(null, { status: method === "DELETE" ? 204 : 404 });
  };

  await cleanupSyntheticPullProof(
    fhir as never,
    "https://fhir.local",
    "synthetic-admin-token",
    new Set(),
    references,
    {
      projectId: "existing-project",
      clientName,
      accessPolicyName: policyName,
      fetchImpl: fakeFetch,
    },
  );

  const expected = [
    "ProjectMembership/membership-one",
    "ProjectMembership/membership-two",
    "ProjectMembership/membership-other-project",
    "AccessPolicy/unique-policy",
    "ClientApplication/unique-client",
  ].sort();
  assert.deepEqual(calls.filter((call) => call.method === "DELETE").map((call) => call.reference).sort(), expected);
  assert.deepEqual(calls.filter((call) => call.method === "GET").map((call) => call.reference).sort(), expected);
  assert.equal(calls.some((call) => call.reference === "Project/existing-project"), false);
});

test("authorization cleanup still rediscovers memberships when another discovery search fails", async () => {
  const clientName = "diagnosis-carry-clinician-unique-run";
  const policyName = "ODOS diagnosis carry clinician proof unique-run";
  const fhir = new CleanupDiscoveryFhir(clientName, policyName);
  fhir.failPolicySearch = true;
  const calls: Array<{ method: string; reference: string }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const reference = String(input).split("/fhir/R4/")[1]!;
    const method = init?.method ?? "GET";
    calls.push({ method, reference });
    return new Response(null, { status: method === "DELETE" ? 204 : 404 });
  };

  await assert.rejects(cleanupSyntheticPullProof(
    fhir as never,
    "https://fhir.local",
    "synthetic-admin-token",
    new Set(),
    new Set(),
    {
      projectId: "existing-project",
      clientName,
      accessPolicyName: policyName,
      knownClientApplicationId: "unique-client",
      knownAccessPolicyId: "unique-policy",
      fetchImpl: fakeFetch,
    },
  ), /cleanup had 1 failure/);

  assert.deepEqual(calls.filter((call) => call.method === "DELETE").map((call) => call.reference).sort(), [
    "AccessPolicy/unique-policy",
    "ClientApplication/unique-client",
    "ProjectMembership/membership-one",
    "ProjectMembership/membership-other-project",
    "ProjectMembership/membership-two",
  ]);
});

test("synthetic cleanup verification attempts every read and rejects a resource that remains", async () => {
  const calls: Array<{ method: string; reference: string }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const reference = String(input).split("/fhir/R4/")[1]!;
    const method = init?.method ?? "GET";
    calls.push({ method, reference });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: reference === "Observation/still-present" ? 200 : 404 });
  };

  await assert.rejects(
    deleteSyntheticReferences(
      "https://fhir.local",
      "synthetic-admin-token",
      new Set(["Condition/gone", "Observation/still-present"]),
      fakeFetch,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      return true;
    },
  );
  assert.deepEqual(calls.filter((call) => call.method === "GET").map((call) => call.reference).sort(), [
    "Condition/gone",
    "Observation/still-present",
  ]);
});

test("synthetic cleanup captures transaction resource ids and versioned locations", () => {
  const references = new Set<string>();
  captureTransactionResponseReferences({
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [
      {
        resource: { resourceType: "Observation", id: "represented" } as Observation,
        response: { status: "201", location: "Observation/represented/_history/1" },
      },
      {
        response: { status: "201", location: "Provenance/location-only/_history/2" },
      },
    ],
  }, references);

  assert.deepEqual([...references], ["Observation/represented", "Provenance/location-only"]);
});

test("proof cleanup arbitration preserves the original primary error when cleanup succeeds", async () => {
  const primary = new Error("primary proof failure");

  await assert.rejects(
    runProofWithCleanup(
      async () => { throw primary; },
      async () => undefined,
    ),
    (error: unknown) => error === primary,
  );
});

test("proof cleanup arbitration returns the cleanup error alone when the proof succeeds", async () => {
  const cleanup = new Error("cleanup failure");

  await assert.rejects(
    runProofWithCleanup(
      async () => undefined,
      async () => { throw cleanup; },
    ),
    (error: unknown) => error === cleanup,
  );
});

test("proof cleanup arbitration preserves primary then every cleanup failure with primary cause", async () => {
  const primary = new Error("primary proof failure");
  const cleanupOne = new Error("first cleanup failure");
  const cleanupTwo = new Error("second cleanup failure");

  await assert.rejects(
    runProofWithCleanup(
      async () => { throw primary; },
      async () => { throw new AggregateError([cleanupOne, cleanupTwo], "cleanup failures"); },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanupOne, cleanupTwo]);
      assert.equal(error.cause, primary);
      return true;
    },
  );
});

test("previous exams preserves FHIR newest-first order across offsets and returns unbounded exact records", async () => {
  const fhir = previousExamFhir();

  const response = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const page = response.body as PreviousExamsPage;
  assert.equal(page.pageSize, 4);
  assert.equal(page.encounters.length, 4);
  assert.deepEqual(page.encounters.map((group) => ({
    encounterReference: group.encounterReference,
    date: group.date,
    visitType: group.visitType,
  })), [
    { encounterReference: "Encounter/prior-1", date: "2026-07-10T08:30:00-04:00", visitType: "Routine eye exam" },
    { encounterReference: "Encounter/prior-2", date: "2026-07-10T12:00:00+00:00", visitType: "Comprehensive eye exam" },
    { encounterReference: "Encounter/prior-3", date: "2026-05-10T09:00:00.000Z", visitType: "Problem visit" },
    { encounterReference: "Encounter/prior-4", date: "2026-04-10T09:00:00.000Z", visitType: "Visit type not recorded" },
  ]);
  assert.ok(page.nextCursor);
  assert.equal(page.nextCursor.includes("http"), false);
  assert.equal(page.nextCursor.includes("Encounter"), false);
  assert.equal(page.nextCursor.includes("_page"), false);

  const first = page.encounters[0]!;
  assert.deepEqual(first.diagnoses.slice(0, 3).map((diagnosis) => diagnosis.conditionReference), [
    "Condition/prior-1-dry-eye-od",
    "Condition/prior-1-dry-eye-os",
    "Condition/prior-1-uncataloged",
  ]);
  assert.equal(first.diagnoses.length, 15);
  assert.equal(first.diagnoses.at(-1)?.conditionReference, "Condition/prior-1-extra-12");
  const { findings, ...firstDiagnosis } = first.diagnoses[0]!;
  assert.deepEqual(firstDiagnosis, {
    conditionReference: "Condition/prior-1-dry-eye-od",
    display: "Keratoconjunctivitis sicca, right eye",
    identity: {
      diagnosisKey: "dry_eye",
      coding: [],
      text: "Keratoconjunctivitis sicca, right eye",
      laterality: "OD",
    },
    checked: true,
    currentConditionReference: "Condition/current-dry-eye-od",
  });
  assert.equal(findings.length, 14);
  assert.equal(findings.at(-1)?.observationReference, "Observation/prior-1-bulk-finding-12");
  assert.deepEqual(findings.slice(0, 2), [
      {
        observationReference: "Observation/prior-1-staining-present",
        code: "ocular-surface::STAINING::punctate",
        display: "Punctate staining",
        presence: "present",
        grade: "2+",
        laterality: "OD",
      },
      {
        observationReference: "Observation/prior-1-filaments-absent",
        code: "ocular-surface::FILAMENTS::present",
        display: "Corneal filaments",
        presence: "absent",
        laterality: "OD",
      },
    ]);
  assert.equal(first.diagnoses[1]!.identity.laterality, "OS");
  assert.equal(first.diagnoses[1]!.checked, false);
  assert.deepEqual(first.diagnoses[2]!.identity, {
    coding: [
      { system: "urn:system:a", code: "alpha", display: "Alpha coding" },
      { system: "urn:system:z", code: "zeta", display: "Zeta coding" },
    ],
    text: "Literal uncataloged diagnosis",
    laterality: "UNKNOWN",
  });

  const secondDryEye = page.encounters[1]!.diagnoses.find((diagnosis) =>
    diagnosis.conditionReference === "Condition/prior-2-dry-eye-od"
  );
  assert.deepEqual(secondDryEye?.identity, first.diagnoses[0]!.identity);
  assert.equal(secondDryEye?.currentConditionReference, "Condition/current-dry-eye-od");
  assert.deepEqual(fhir.initialEncounterSearch, {
    subject: "Patient/patient-1",
    date: "lt2026-08-10T09:00:00.000Z",
    _sort: "-date",
    _count: "4",
  });
});

test("previous exams omits an entered-in-error Encounter from the GET page", async () => {
  const fhir = previousExamFhir();
  fhir.resource<Encounter>("Encounter", "prior-2").status = "entered-in-error";

  const response = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const page = response.body as PreviousExamsPage;
  assert.equal(page.encounters.some((group) => group.encounterReference === "Encounter/prior-2"), false);
});

test("previous exams omits a diagnosis whose Condition belongs to another Encounter", async () => {
  const fhir = previousExamFhir();
  fhir.resource<Condition>("Condition", "prior-1-dry-eye-os").encounter = { reference: "Encounter/prior-2" };

  const response = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const priorOne = (response.body as PreviousExamsPage).encounters.find((group) =>
    group.encounterReference === "Encounter/prior-1"
  );
  assert.ok(priorOne);
  assert.equal(priorOne.diagnoses.some((diagnosis) =>
    diagnosis.conditionReference === "Condition/prior-1-dry-eye-os"
  ), false);
});

test("previous exams omits evidence whose Observation belongs to another Encounter", async () => {
  const fhir = previousExamFhir();
  fhir.resource<Observation>("Observation", "prior-1-filaments-absent").encounter = { reference: "Encounter/prior-2" };

  const response = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const priorOne = (response.body as PreviousExamsPage).encounters.find((group) =>
    group.encounterReference === "Encounter/prior-1"
  );
  const diagnosis = priorOne?.diagnoses.find((candidate) =>
    candidate.conditionReference === "Condition/prior-1-dry-eye-od"
  );
  assert.equal(diagnosis?.findings.some((finding) =>
    finding.observationReference === "Observation/prior-1-filaments-absent"
  ), false);
});

test("previous exams enforces active visit and same-Encounter membership for diagnoses and evidence together", async () => {
  const fhir = previousExamFhir();
  fhir.resource<Encounter>("Encounter", "prior-2").status = "entered-in-error";
  fhir.resource<Condition>("Condition", "prior-1-dry-eye-os").encounter = { reference: "Encounter/prior-2" };
  fhir.resource<Observation>("Observation", "prior-1-filaments-absent").encounter = { reference: "Encounter/prior-2" };

  const response = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const page = response.body as PreviousExamsPage;
  assert.equal(page.encounters.some((group) => group.encounterReference === "Encounter/prior-2"), false);
  const priorOne = page.encounters.find((group) => group.encounterReference === "Encounter/prior-1");
  assert.ok(priorOne);
  assert.equal(priorOne.diagnoses.some((diagnosis) =>
    diagnosis.conditionReference === "Condition/prior-1-dry-eye-os"
  ), false);
  const diagnosis = priorOne.diagnoses.find((candidate) =>
    candidate.conditionReference === "Condition/prior-1-dry-eye-od"
  );
  assert.equal(diagnosis?.findings.some((finding) =>
    finding.observationReference === "Observation/prior-1-filaments-absent"
  ), false);
});

test("previous exams cursor loads the next four-encounter page without accepting a URL", async () => {
  const fhir = previousExamFhir();
  const first = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });
  const firstPage = first.body as PreviousExamsPage;

  const second = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: { cursor: firstPage.nextCursor },
  });

  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(second.body, {
    pageSize: 4,
    encounters: [{
      encounterReference: "Encounter/prior-5",
      date: "2026-03-10T09:00:00.000Z",
      visitType: "Annual eye exam",
      diagnoses: [],
    }],
  });
  assert.equal(fhir.followedUrls.length, 1);
  assert.equal(fhir.followedUrls[0], "/fhir/R4/Encounter?_page=2&_count=4");

  const rejected = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: { cursor: "https://attacker.example/fhir/R4/Encounter?_page=2" },
  });
  assert.equal(rejected.status, 400);
  assert.equal(fhir.followedUrls.length, 1);
});

test("previous exams rejects forged legacy and tampered cursor payloads before FHIR pagination", async () => {
  const fhir = previousExamFhir();
  const cursorPath = "/fhir/R4/Encounter?_page=2&_count=4";
  const forged = (payload: Record<string, unknown>) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const issued = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });
  const cursor = (issued.body as PreviousExamsPage).nextCursor;
  assert.ok(cursor);
  const [payload, signature] = cursor.split(".");
  assert.ok(payload);
  assert.ok(signature);
  const signedPayload = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const tampered = (changes: Record<string, unknown>): string =>
    `${forged({ ...signedPayload, ...changes })}.${signature}`;
  const cursors = {
    "legacy v1 same-origin path": forged({ v: 1, path: cursorPath }),
    "tampered path": tampered({ path: `${cursorPath}&tampered=true` }),
    "tampered context": tampered({ encounterId: "other-current-encounter" }),
    "tampered signature": `${payload}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`,
  };

  fhir.followedUrls.length = 0;

  for (const [name, cursor] of Object.entries(cursors)) {
    const response = await handlePreviousExamsReadRequest(deps(fhir), {
      authHeader: AUTH_CLINICIAN,
      params: { encounterId: "current" },
      query: { cursor },
    });

    assert.equal(response.status, 400, name);
    assert.equal(fhir.followedUrls.length, 0, name);
  }
});

test("previous exams binds an issued cursor to the current Encounter, patient, and start instant", async () => {
  const fhir = previousExamFhir();
  const first = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });
  const cursor = (first.body as PreviousExamsPage).nextCursor;
  assert.ok(cursor);
  fhir.resources.push(
    { resourceType: "Patient", id: "patient-2", active: true },
    { ...encounter("other-encounter", "2026-08-10T09:00:00.000Z", "Other exam", []), subject: { reference: "Patient/patient-1" } },
    { ...encounter("other-patient", "2026-08-10T09:00:00.000Z", "Other patient exam", []), subject: { reference: "Patient/patient-2" } },
    { ...encounter("other-date", "2026-08-09T09:00:00.000Z", "Other date exam", []), subject: { reference: "Patient/patient-1" } },
  );

  for (const encounterId of ["other-encounter", "other-patient", "other-date"]) {
    const response = await handlePreviousExamsReadRequest(deps(fhir), {
      authHeader: AUTH_CLINICIAN,
      params: { encounterId },
      query: { cursor },
    });

    assert.equal(response.status, 400, encounterId);
    assert.equal(fhir.followedUrls.length, 0, encounterId);
  }
});

test("previous exams maps initial Encounter and Patient FHIR access failures at the direct boundary", async () => {
  for (const [reference, status, expected] of [
    ["Encounter/current", 401, 403],
    ["Encounter/current", 403, 403],
    ["Encounter/current", 404, 404],
    ["Patient/patient-1", 401, 403],
    ["Patient/patient-1", 403, 403],
    ["Patient/patient-1", 410, 404],
  ] as const) {
    const fhir = previousExamFhir();
    fhir.readFailures.set(reference, status);
    const response = await handlePreviousExamsReadRequest(deps(fhir), {
      authHeader: AUTH_CLINICIAN,
      params: { encounterId: "current" },
      query: {},
    });

    assert.equal(response.status, expected, `${reference} ${status}: ${JSON.stringify(response.body)}`);
  }
});

test("previous exams maps page Condition and Observation FHIR access failures at the direct boundary", async () => {
  for (const [reference, status, expected] of [
    ["Condition/prior-1-dry-eye-od", 401, 403],
    ["Condition/prior-1-dry-eye-od", 404, 404],
    ["Observation/prior-1-staining-present", 403, 403],
    ["Observation/prior-1-staining-present", 410, 404],
  ] as const) {
    const fhir = previousExamFhir();
    fhir.readFailures.set(reference, status);
    const response = await handlePreviousExamsReadRequest(deps(fhir), {
      authHeader: AUTH_CLINICIAN,
      params: { encounterId: "current" },
      query: {},
    });

    assert.equal(response.status, expected, `${reference} ${status}: ${JSON.stringify(response.body)}`);
  }
});

test("previous exams registered route maps cursor-page FHIR denials and missing history without a generic 500", async (t) => {
  for (const [status, expected] of [[403, 403], [404, 404]] as const) {
    const fhir = previousExamFhir();
    const first = await handlePreviousExamsReadRequest(deps(fhir), {
      authHeader: AUTH_CLINICIAN,
      params: { encounterId: "current" },
      query: {},
    });
    const cursor = (first.body as PreviousExamsPage).nextCursor;
    assert.ok(cursor);
    fhir.searchUrlFailures.set("/fhir/R4/Encounter?_page=2&_count=4", status);
    const base = await startPreviousExamRoutes(t, fhir, "auditor");

    const response = await fetch(
      `${base}/clinical-graph/encounters/current/previous-exams?cursor=${encodeURIComponent(cursor)}`,
      { headers: { Authorization: AUTH_CLINICIAN } },
    );

    assert.equal(response.status, expected, `${status}: ${await response.clone().text()}`);
    assert.doesNotMatch(await response.text(), /previous exams read failed/i);
  }
});

test("previous exams rejects a cross-origin Bundle next link", async () => {
  const fhir = previousExamFhir();
  fhir.nextUrl = "https://evil.example/fhir/R4/Encounter?_page=2&_count=4";

  const response = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });

  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { error: "FHIR previous-exams next link is invalid." });
});

test("previous exams rejects a scheme-relative cross-origin Bundle next link", async () => {
  const fhir = previousExamFhir();
  fhir.nextUrl = "//evil.example/fhir/R4/Encounter?_page=2&_count=4";

  const response = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });

  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { error: "FHIR previous-exams next link is invalid." });
});

test("previous exams accepts a same-origin absolute Bundle next link", async () => {
  const fhir = previousExamFhir();
  fhir.nextUrl = "https://fhir.local/fhir/R4/Encounter?_page=2&_count=4";

  const first = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });
  const firstPage = first.body as PreviousExamsPage;
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(firstPage.nextCursor);

  const second = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: { cursor: firstPage.nextCursor },
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(fhir.followedUrls, ["/fhir/R4/Encounter?_page=2&_count=4"]);
});

async function activeProjectId(baseUrl: string, accessToken: string): Promise<string> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(response.status, 200, "Existing local project lookup failed.");
  const body = await response.json() as { project?: { id?: string } };
  assert.ok(body.project?.id, "Admin identity has no active local project.");
  return body.project.id;
}

async function createDisposableClientApplication(
  baseUrl: string,
  accessToken: string,
  projectId: string,
  accessPolicyReference: string,
  clientName: string,
  onCreatedId?: (id: string) => void,
): Promise<{ id: string; secret: string }> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/admin/projects/${projectId}/client`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: clientName,
      description: "Disposable synthetic clinician policy proof",
      accessPolicy: { reference: accessPolicyReference },
    }),
  });
  assert.equal(response.status, 201, "Disposable clinician client creation failed.");
  const body = await response.json() as { id?: string; secret?: string };
  if (body.id) onCreatedId?.(body.id);
  assert.ok(body.id && body.secret, "Disposable clinician client response was incomplete.");
  return { id: body.id, secret: body.secret };
}

async function clientCredentialsToken(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  assert.equal(response.status, 200, "Disposable clinician token grant failed.");
  const body = await response.json() as { access_token?: string };
  assert.ok(body.access_token, "Disposable clinician token response was incomplete.");
  return body.access_token;
}

function syntheticEncounter(patientReference: string, system: string, identifier: string): Encounter {
  return {
    resourceType: "Encounter",
    identifier: [{ system, value: identifier }],
    status: "planned",
    class: { system, code: "synthetic" },
    subject: { reference: patientReference },
    period: { start: new Date().toISOString() },
  };
}

function syntheticEvidence(
  patientReference: string,
  encounterReference: string,
  system: string,
  code: string,
  valueBoolean: boolean,
): Observation {
  return {
    resourceType: "Observation",
    identifier: [{ system, value: code }],
    status: "final",
    code: { coding: [{ system, code }], text: code },
    subject: { reference: patientReference },
    encounter: { reference: encounterReference },
    valueBoolean,
  };
}

async function assertNoTransactionLeaks(
  fhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"],
  encounterId: string,
  detail?: unknown,
): Promise<void> {
  const leaks = await transactionResourcesForEncounter(fhir, encounterId);
  assert.deepEqual(
    leaks.map((resource) => `${resource.resourceType}/${resource.id}`),
    [],
    JSON.stringify(detail),
  );
}

function captureTransactionResponseReferences(bundle: Bundle | undefined, references: Set<string>): void {
  for (const entry of bundle?.entry ?? []) {
    if (entry.resource?.id) references.add(`${entry.resource.resourceType}/${entry.resource.id}`);
    const locationReference = referenceFromTransactionLocation(entry.response?.location);
    if (locationReference) references.add(locationReference);
  }
}

function referenceFromTransactionLocation(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const match = location.match(/(?:^|\/)([A-Z][A-Za-z]+)\/([^/?]+)(?:\/_history\/[^/?]+)?(?:\?.*)?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function runProofWithCleanup<T>(
  proof: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let proofResult: T | undefined;
  let proofError: unknown;
  let proofFailed = false;
  try {
    proofResult = await proof();
  } catch (error) {
    proofFailed = true;
    proofError = error;
  }

  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (proofFailed) {
    if (cleanupFailed) {
      const cleanupErrors = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
      throw new AggregateError(
        [proofError, ...cleanupErrors],
        `Diagnosis pull proof and cleanup failed with ${cleanupErrors.length} cleanup failure(s).`,
        { cause: proofError },
      );
    }
    throw proofError;
  }
  if (cleanupFailed) throw cleanupError;
  return proofResult as T;
}

async function cleanupSyntheticPullProof(
  fhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"],
  baseUrl: string,
  accessToken: string,
  encounterIds: Set<string>,
  references: Set<string>,
  identity?: {
    projectId?: string;
    clientName: string;
    accessPolicyName: string;
    knownClientApplicationId?: string;
    knownAccessPolicyId?: string;
    fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  },
): Promise<void> {
  const failures: unknown[] = [];
  if (identity) {
    try {
      await discoverDisposableAuthorizationReferences(fhir, identity, references);
    } catch (error) {
      failures.push(new Error("Synthetic authorization cleanup discovery failed.", { cause: error }));
    }
  }
  for (const encounterId of encounterIds) {
    const encounterReference = `Encounter/${encounterId}`;
    const searches = [
      ["Condition", { encounter: encounterReference }],
      ["Observation", { encounter: encounterReference }],
      ["Provenance", { target: encounterReference }],
    ] as const;
    for (const [resourceType, params] of searches) {
      try {
        const resources = resourceType === "Condition"
          ? await allSearchResources<Condition>(fhir, resourceType, params)
          : resourceType === "Observation"
            ? await allSearchResources<Observation>(fhir, resourceType, params)
            : await allSearchResources<Provenance>(fhir, resourceType, params);
        for (const resource of resources) {
          if (resource.id) references.add(`${resource.resourceType}/${resource.id}`);
        }
      } catch (error) {
        failures.push(new Error(
          `Synthetic cleanup sweep failed for ${resourceType} on Encounter/${encounterId}.`,
          { cause: error },
        ));
      }
    }
  }
  try {
    await deleteSyntheticReferences(baseUrl, accessToken, references, identity?.fetchImpl);
  } catch (error) {
    if (error instanceof AggregateError) failures.push(...error.errors);
    else failures.push(error);
  }
  if (failures.length) {
    throw new AggregateError(failures, `Synthetic diagnosis pull cleanup had ${failures.length} failure(s).`);
  }
}

async function discoverDisposableAuthorizationReferences(
  fhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"],
  identity: {
    projectId?: string;
    clientName: string;
    accessPolicyName: string;
    knownClientApplicationId?: string;
    knownAccessPolicyId?: string;
  },
  references: Set<string>,
): Promise<void> {
  const failures: unknown[] = [];
  const clientIds = new Set<string>();
  if (identity.knownClientApplicationId) {
    clientIds.add(identity.knownClientApplicationId);
    references.add(`ClientApplication/${identity.knownClientApplicationId}`);
  }
  if (identity.knownAccessPolicyId) references.add(`AccessPolicy/${identity.knownAccessPolicyId}`);

  let clients: ClientApplication[] = [];
  try {
    clients = await allSearchResources<ClientApplication>(fhir, "ClientApplication", { name: identity.clientName });
  } catch (error) {
    failures.push(error);
  }
  for (const client of clients) {
    if (client.id && client.name === identity.clientName) clientIds.add(client.id);
  }
  let policies: AccessPolicy[] = [];
  try {
    policies = await allSearchResources<AccessPolicy>(fhir, "AccessPolicy", { name: identity.accessPolicyName });
  } catch (error) {
    failures.push(error);
  }
  for (const policy of policies) {
    if (policy.id && policy.name === identity.accessPolicyName) references.add(`AccessPolicy/${policy.id}`);
  }
  for (const clientId of clientIds) {
    references.add(`ClientApplication/${clientId}`);
    if (!identity.projectId) continue;
    let memberships: ProjectMembership[] = [];
    try {
      memberships = await allSearchResources<ProjectMembership>(fhir, "ProjectMembership", {
        profile: `ClientApplication/${clientId}`,
      });
    } catch (error) {
      failures.push(error);
    }
    for (const membership of memberships) {
      if (
        membership.id &&
        membership.profile.reference === `ClientApplication/${clientId}`
      ) {
        references.add(`ProjectMembership/${membership.id}`);
      }
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `Synthetic authorization discovery had ${failures.length} failure(s).`);
  }
}

async function transactionResourcesForEncounter(
  fhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"],
  encounterId: string,
): Promise<Array<Condition | Observation | Provenance>> {
  const encounterReference = `Encounter/${encounterId}`;
  const [conditions, observations, provenances] = await Promise.all([
    allSearchResources(fhir, "Condition", { encounter: encounterReference }),
    allSearchResources(fhir, "Observation", { encounter: encounterReference }),
    allSearchResources(fhir, "Provenance", { target: encounterReference }),
  ]);
  return [...conditions, ...observations, ...provenances];
}

async function allSearchResources<T extends Resource>(
  fhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"],
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<T[]> {
  const resources: T[] = [];
  let bundle = await fhir.search<T>(resourceType, params);
  while (true) {
    resources.push(...(bundle.entry?.flatMap((entry) => entry.resource ? [entry.resource] : []) ?? []));
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    if (!next) return resources;
    assert.ok(fhir.searchUrl, "FHIR cleanup pagination is unavailable.");
    bundle = await fhir.searchUrl<T>(next, resourceType);
  }
}

async function deleteSyntheticReferences(
  baseUrl: string,
  accessToken: string,
  references: Set<string>,
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const failures: unknown[] = [];
  const orderedReferences = [...references].reverse();
  for (const reference of orderedReferences) {
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/fhir/R4/${reference}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (
        response.status !== 200 && response.status !== 204 &&
        response.status !== 404 && response.status !== 410
      ) {
        failures.push(new Error(`Synthetic cleanup failed for ${reference} with HTTP ${response.status}.`));
      }
    } catch (error) {
      failures.push(new Error(`Synthetic cleanup request failed for ${reference}.`, { cause: error }));
    }
  }
  for (const reference of orderedReferences) {
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/fhir/R4/${reference}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.status !== 404 && response.status !== 410) {
        failures.push(new Error(`Synthetic cleanup verification failed for ${reference} with HTTP ${response.status}.`));
      }
    } catch (error) {
      failures.push(new Error(`Synthetic cleanup verification failed for ${reference}.`, { cause: error }));
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `Synthetic reference deletion had ${failures.length} failure(s).`);
  }
}

async function startPreviousExamRoutes(
  t: TestContext,
  fhir: MemoryFhir,
  forbiddenRole: PracticeRoleId,
  rollbackFhir?: Pick<DiagnosisCarryForwardFhirClient, "read" | "executeTransaction">,
): Promise<string> {
  const app = express();
  app.use(express.json());
  const routeDeps = {
    authenticateService: async () => undefined,
    fhirBaseUrl: "https://fhir.local",
    authenticate: async (header: string | undefined) => header === AUTH_FORBIDDEN
      ? { staffReference: "Practitioner/forbidden", actorRole: forbiddenRole, fhir: unreachableFhir }
      : header === AUTH_CLINICIAN
        ? { staffReference: "Practitioner/doc", actorRole: "clinician", fhir }
        : null,
    authenticateWrite: async (header: string | undefined) => header === AUTH_FORBIDDEN
      ? { staffReference: "Practitioner/forbidden", actorRole: forbiddenRole, fhir: unreachableFhir }
      : header === AUTH_CLINICIAN
        ? { staffReference: "Practitioner/doc", actorRole: "clinician", fhir }
        : null,
    ...(rollbackFhir ? { rollbackFhir } : {}),
  };
  registerDiagnosisCarryForwardRoutes(app, routeDeps);
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  t.after(() => listener.close());
  return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
}

function mixedConflictTransactionResponse(response: Bundle): Bundle {
  const changed = structuredClone(response);
  changed.entry?.forEach((entry, index) => {
    if (index === 0) {
      entry.response = { status: "412 Precondition Failed" };
      return;
    }
    assert.ok(entry.resource?.id);
    entry.response = {
      status: "201 Created",
      location: `${entry.resource.resourceType}/${entry.resource.id}/_history/1`,
    };
  });
  return changed;
}

class CleanupDiscoveryFhir {
  failPolicySearch = false;

  constructor(
    private readonly clientName: string,
    private readonly policyName: string,
  ) {}

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    if (resourceType === "AccessPolicy" && this.failPolicySearch) {
      throw new Error("Synthetic AccessPolicy discovery failure");
    }
    let resources: Resource[] = [];
    if (resourceType === "ClientApplication" && params.name === this.clientName) {
      resources = [{
        resourceType: "ClientApplication",
        id: "unique-client",
        name: this.clientName,
      } as ClientApplication];
    } else if (resourceType === "AccessPolicy" && params.name === this.policyName) {
      resources = [{
        resourceType: "AccessPolicy",
        id: "unique-policy",
        name: this.policyName,
      } as AccessPolicy];
    } else if (
      resourceType === "ProjectMembership" &&
      params.profile === "ClientApplication/unique-client"
    ) {
      resources = ["membership-one", "membership-two", "membership-other-project"].map((id): ProjectMembership => ({
        resourceType: "ProjectMembership",
        id,
        project: { reference: id === "membership-other-project" ? "Project/unexpected-project" : "Project/existing-project" },
        profile: { reference: "ClientApplication/unique-client" },
      }));
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource: resource as T })),
    };
  }
}

class MemoryRollbackFhir {
  readonly transactions: Bundle[] = [];
  readonly readReferences = new Set<string>();
  readonly remaining: Set<string>;
  failDelete = false;
  keepReadable = false;
  deleteStatus = "204 No Content";
  readError: Error | undefined;

  constructor(references: string[]) {
    this.remaining = new Set(references);
  }

  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    this.transactions.push(structuredClone(bundle));
    if (!this.failDelete) {
      for (const entry of bundle.entry ?? []) {
        if (entry.request?.url) this.remaining.delete(entry.request.url);
      }
    }
    return {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: (bundle.entry ?? []).map(() => ({
        response: { status: this.failDelete ? "500 Internal Server Error" : this.deleteStatus },
      })),
    };
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const reference = `${resourceType}/${id}`;
    this.readReferences.add(reference);
    if (this.readError) throw this.readError;
    if (this.keepReadable || this.remaining.has(reference)) {
      return { resourceType, id } as T;
    }
    throw Object.assign(new Error(`Missing ${reference}`), { status: 404 });
  }
}

async function postPull(base: string, sourceConditionId: string): Promise<Response> {
  return fetch(`${base}/clinical-graph/encounters/current-pull/previous-exams`, {
    method: "POST",
    headers: { Authorization: AUTH_CLINICIAN, "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceEncounterReference: "Encounter/source-pull",
      sourceConditionReference: `Condition/${sourceConditionId}`,
    }),
  });
}

function deps(fhir: MemoryFhir) {
  return {
    fhirBaseUrl: "https://fhir.local",
    authenticate: async (header: string | undefined) => header === AUTH_CLINICIAN
      ? { staffReference: "Practitioner/doc", actorRole: "clinician" as const, fhir }
      : null,
  };
}

function previousExamFhir(): MemoryFhir {
  const fhir = new MemoryFhir();
  fhir.resources.push({ resourceType: "Patient", id: "patient-1", active: true });
  fhir.resources.push(encounter("current", "2026-08-10T09:00:00.000Z", "Current exam", ["current-dry-eye-od"]));
  fhir.resources.push(encounter("prior-1", "2026-07-10T08:30:00-04:00", "Routine eye exam", [
    "prior-1-dry-eye-od",
    "prior-1-dry-eye-os",
    "prior-1-uncataloged",
    "prior-1-refuted",
    "prior-1-entered-error",
    ...Array.from({ length: 12 }, (_, index) => `prior-1-extra-${String(index + 1).padStart(2, "0")}`),
  ]));
  fhir.resources.push(encounter("prior-2", "2026-07-10T12:00:00+00:00", "Comprehensive eye exam", ["prior-2-dry-eye-od"]));
  fhir.resources.push(encounter("prior-3", "2026-05-10T09:00:00.000Z", "Problem visit", ["prior-3-other"]));
  fhir.resources.push(encounter("prior-4", "2026-04-10T09:00:00.000Z", undefined, ["prior-4-other"]));
  fhir.resources.push(encounter("prior-5", "2026-03-10T09:00:00.000Z", "Annual eye exam", []));

  fhir.resources.push(diagnosis("current-dry-eye-od", "current", "dry_eye", "right", "confirmed", []));
  fhir.resources.push(diagnosis("prior-1-dry-eye-od", "prior-1", "dry_eye", "right", "confirmed", [
    "prior-1-staining-present",
    "prior-1-filaments-absent",
    "prior-1-no-boolean",
    "prior-1-entered-error-observation",
    ...Array.from({ length: 12 }, (_, index) => `prior-1-bulk-finding-${String(index + 1).padStart(2, "0")}`),
  ]));
  fhir.resources.push(diagnosis("prior-1-dry-eye-os", "prior-1", "dry_eye", "left", "confirmed", []));
  fhir.resources.push({
    ...diagnosis("prior-1-uncataloged", "prior-1", undefined, "unspecified", "provisional", []),
    code: {
      coding: [
        { system: "urn:system:z", code: "zeta", display: "Zeta coding" },
        { system: "urn:system:a", code: "alpha", display: "Alpha coding" },
      ],
      text: "Literal uncataloged diagnosis",
    },
  });
  fhir.resources.push(diagnosis("prior-1-refuted", "prior-1", "refuted", "right", "refuted", []));
  fhir.resources.push(diagnosis("prior-1-entered-error", "prior-1", "entered_error", "right", "entered-in-error", []));
  fhir.resources.push(diagnosis("prior-2-dry-eye-od", "prior-2", "dry_eye", "right", "confirmed", []));
  fhir.resources.push(diagnosis("prior-3-other", "prior-3", "other", "bilateral", "differential", []));
  fhir.resources.push(diagnosis("prior-4-other", "prior-4", "other", "unspecified", "unconfirmed", []));
  for (let index = 1; index <= 12; index += 1) {
    const suffix = String(index).padStart(2, "0");
    fhir.resources.push(diagnosis(`prior-1-extra-${suffix}`, "prior-1", `extra_${suffix}`, "unspecified", "confirmed", []));
  }

  fhir.resources.push(finding(
    "prior-1-staining-present",
    "prior-1",
    "ocular-surface::STAINING::punctate",
    "Punctate staining",
    true,
    "OD",
    "2+",
  ));
  fhir.resources.push(finding(
    "prior-1-filaments-absent",
    "prior-1",
    "ocular-surface::FILAMENTS::present",
    "Corneal filaments",
    false,
    "OD",
  ));
  const noBoolean = finding(
    "prior-1-no-boolean",
    "prior-1",
    "ocular-surface::TEAR::debris",
    "Tear debris",
    true,
    "OD",
  );
  delete noBoolean.valueBoolean;
  noBoolean.valueString = "present";
  fhir.resources.push(noBoolean);
  fhir.resources.push({
    ...finding(
      "prior-1-entered-error-observation",
      "prior-1",
      "ocular-surface::SCAR::present",
      "Corneal scar",
      true,
      "OD",
    ),
    status: "entered-in-error",
  });
  for (let index = 1; index <= 12; index += 1) {
    const suffix = String(index).padStart(2, "0");
    fhir.resources.push(finding(
      `prior-1-bulk-finding-${suffix}`,
      "prior-1",
      `synthetic-finding-${suffix}`,
      `Synthetic finding ${suffix}`,
      index % 2 === 0,
      "OD",
    ));
  }
  return fhir;
}

function pullFhir(sourceConditionId = "source-dry-eye-od"): MemoryFhir {
  const fhir = new MemoryFhir();
  fhir.resources.push({ resourceType: "Patient", id: "patient-1", active: true });
  const current = encounter("current-pull", "2026-08-10T09:00:00.000Z", "Current exam", [
    "current-other-1",
    "current-other-2",
  ]);
  current.meta = { versionId: "7" };
  current.diagnosis![0]!.rank = 1;
  current.diagnosis![1]!.rank = 4;
  fhir.resources.push(current);
  fhir.resources.push(encounter("source-pull", "2026-07-10T09:00:00.000Z", "Prior exam", [sourceConditionId]));
  fhir.resources.push(diagnosis("current-other-1", "current-pull", "other_1", "unspecified", "confirmed", []));
  fhir.resources.push(diagnosis("current-other-2", "current-pull", "other_2", "bilateral", "confirmed", []));

  const sourceOd = diagnosis("source-dry-eye-od", "source-pull", "dry_eye", "right", "confirmed", [
    "source-staining-present",
    "source-filaments-absent",
    "source-legacy-no-boolean",
  ]);
  sourceOd.extension = [{
    url: ODOS_EXTENSION_URLS.eyeLaterality,
    valueCodeableConcept: lateralityConcept("OD"),
  }];
  fhir.resources.push(sourceOd);
  const sourceOs = diagnosis("source-dry-eye-os", "source-pull", "dry_eye", "left", "confirmed", []);
  sourceOs.extension = [{
    url: ODOS_EXTENSION_URLS.eyeLaterality,
    valueCodeableConcept: lateralityConcept("OS"),
  }];
  fhir.resources.push(sourceOs);
  fhir.resources.push({
    ...diagnosis("source-uncataloged", "source-pull", undefined, "unspecified", "confirmed", []),
    code: {
      coding: [
        { system: "urn:literal:z", code: "z", display: "Literal Z" },
        { system: "urn:literal:a", code: "a", display: "Literal A" },
      ],
      text: "Literal uncataloged diagnosis",
    },
  });
  fhir.resources.push(finding(
    "source-staining-present",
    "source-pull",
    "ocular-surface::STAINING::punctate",
    "Punctate staining",
    true,
    "OD",
    "2+",
  ));
  fhir.resources.push(finding(
    "source-filaments-absent",
    "source-pull",
    "ocular-surface::FILAMENTS::present",
    "Corneal filaments",
    false,
    "OD",
  ));
  const sourceLegacy = finding(
    "source-legacy-no-boolean",
    "source-pull",
    "ocular-surface::LEGACY::finding",
    "Legacy source finding",
    true,
    "OD",
  );
  delete sourceLegacy.valueBoolean;
  sourceLegacy.valueString = "Legacy recorded value";
  fhir.resources.push(sourceLegacy);
  return fhir;
}

function encounter(
  id: string,
  date: string,
  visitType: string | undefined,
  conditionIds: string[],
): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: id === "current" ? "in-progress" : "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
    subject: { reference: "Patient/patient-1" },
    period: { start: date, end: date },
    ...(visitType ? { type: [{ text: visitType }] } : {}),
    diagnosis: conditionIds.map((conditionId, index) =>
      buildEncounterDiagnosisComponent(`Condition/${conditionId}`, index + 1)
    ),
  };
}

function diagnosis(
  id: string,
  encounterId: string,
  diagnosisKey: string | undefined,
  laterality: "right" | "left" | "bilateral" | "unspecified",
  verificationStatus: ConditionVerificationStatusCode,
  evidenceIds: string[],
): Condition {
  const code = diagnosisKey === "dry_eye"
    ? { text: `Keratoconjunctivitis sicca, ${laterality === "left" ? "left" : "right"} eye` }
    : { text: diagnosisKey ?? "Literal uncataloged diagnosis" };
  return {
    ...buildEncounterDiagnosisCondition({
      patientReference: "Patient/patient-1",
      encounterReference: `Encounter/${encounterId}`,
      code,
      verificationStatus,
      ...(diagnosisKey ? {
        identifiers: [{
          system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
          value: `${encounterId}::${diagnosisKey}::${laterality}`,
        }],
      } : {}),
      evidenceObservationReferences: evidenceIds.map((evidenceId) => `Observation/${evidenceId}`),
    }),
    id,
  };
}

function finding(
  id: string,
  encounterId: string,
  code: string,
  display: string,
  valueBoolean: boolean,
  laterality: "OD" | "OS" | "OU",
  grade?: string,
): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "preliminary",
    code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code, display }], text: display },
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: `Encounter/${encounterId}` },
    effectiveDateTime: "2026-07-10T09:05:00.000Z",
    valueBoolean,
    extension: [{
      url: ODOS_EXTENSION_URLS.eyeLaterality,
      valueCodeableConcept: lateralityConcept(laterality),
    }],
    ...(grade ? {
      component: [{
        code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: "GRADE", display: "Grade" }] },
        valueString: grade,
      }],
    } : {}),
  };
}

function carryChainFhir(depth: number): MemoryFhir {
  const fhir = new MemoryFhir();
  for (let index = 0; index <= depth; index += 1) {
    const date = new Date(Date.UTC(2025, 3, 1 + index, 9)).toISOString();
    fhir.resources.push(encounter(
      `carry-encounter-${index}`,
      date,
      "Synthetic carry exam",
      [`carry-condition-${index}`],
    ));
    fhir.resources.push(diagnosis(
      `carry-condition-${index}`,
      `carry-encounter-${index}`,
      "dry_eye",
      "right",
      "confirmed",
      [],
    ));
    if (index === 0) continue;
    fhir.resources.push(targetProvenance(
      `carry-provenance-${index}`,
      new Date(Date.UTC(2025, 3, 1 + index, 12)).toISOString(),
      [`Condition/carry-condition-${index}`],
      "CREATE",
      "Diagnosis pull-forward",
      [`Condition/carry-condition-${index - 1}`],
    ));
  }
  return fhir;
}

function targetProvenance(
  id: string,
  recorded: string,
  targets: string[],
  activityCode: "CREATE" | "UPDATE",
  activityText: string,
  entities: string[] = [],
): Provenance {
  return {
    resourceType: "Provenance",
    id,
    target: targets.map((reference) => ({ reference })),
    recorded,
    activity: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation",
        code: activityCode,
      }],
      text: activityText,
    },
    agent: [{ who: { display: "Synthetic test actor" } }],
    ...(entities.length ? {
      entity: entities.map((reference) => ({ role: "source" as const, what: { reference } })),
    } : {}),
  };
}

function carryObservation(id: string, encounterId: string): Observation {
  return finding(
    id,
    encounterId,
    "ocular-surface::STAINING::punctate",
    "Punctate staining",
    true,
    "OD",
    "2+",
  );
}

const unreachableFhir = new Proxy({}, {
  get() {
    throw new Error("FHIR must not be reached before route authorization succeeds.");
  },
});

class MemoryFhir {
  readonly resources: Resource[] = [];
  readonly followedUrls: string[] = [];
  readonly transactions: Array<{
    bundle: Bundle;
    headers: Record<string, string>;
    options?: { autoRollbackCreatedEntries?: boolean };
  }> = [];
  readonly readFailures = new Map<string, number>();
  readonly searchUrlFailures = new Map<string, number>();
  initialEncounterSearch: Record<string, string> | undefined;
  nextUrl = "/fhir/R4/Encounter?_page=2&_count=4";
  transactionFailureStatus: string | undefined;
  transactionErrorStatus: number | undefined;
  transactionResponseMutator: ((response: Bundle) => Bundle) | undefined;
  beforeCurrentEncounterRead: ((readNumber: number) => void) | undefined;
  beforeTransaction: (() => void) | undefined;
  transactionRequestMutator: ((bundle: Bundle) => void) | undefined;
  provenancePageTarget: string | undefined;
  provenancePages: Provenance[][] | undefined;
  private currentEncounterReads = 0;

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    if (resourceType === "Encounter" && id === "current-pull") {
      this.currentEncounterReads += 1;
      this.beforeCurrentEncounterRead?.(this.currentEncounterReads);
    }
    const failedStatus = this.readFailures.get(`${resourceType}/${id}`);
    if (failedStatus) throw Object.assign(new Error(`Synthetic FHIR ${failedStatus}`), { status: failedStatus });
    const resource = this.resources.find((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    if (!resource) throw Object.assign(new Error(`Missing ${resourceType}/${id}`), { status: 404 });
    return structuredClone(resource as T);
  }

  resource<T extends Resource>(resourceType: T["resourceType"], id: string): T {
    const resource = this.resources.find((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return resource as T;
  }

  remove(reference: string): void {
    const [resourceType, id] = reference.split("/");
    const index = this.resources.findIndex((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    if (index >= 0) this.resources.splice(index, 1);
  }

  async executeTransaction(
    bundle: Bundle,
    headers: Record<string, string> = {},
    options?: { autoRollbackCreatedEntries?: boolean },
  ): Promise<Bundle> {
    this.transactionRequestMutator?.(bundle);
    this.transactions.push({
      bundle: structuredClone(bundle),
      headers: structuredClone(headers),
      ...(options ? { options: structuredClone(options) } : {}),
    });
    this.beforeTransaction?.();
    if (this.transactionErrorStatus) {
      throw Object.assign(new Error(`FHIR ${this.transactionErrorStatus}`), { status: this.transactionErrorStatus });
    }
    if (this.transactionFailureStatus) {
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: bundle.entry?.map((entry) => ({
          resource: entry.resource,
          response: { status: this.transactionFailureStatus! },
        })),
      };
    }
    const response: Bundle = {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: bundle.entry?.map((entry) => {
        const resource = structuredClone(entry.resource!);
        if (resource.resourceType === "Condition") resource.id = "pulled-condition";
        if (resource.resourceType === "Observation") resource.id = "pulled-observation";
        if (resource.resourceType === "Provenance") resource.id = "pulled-provenance";
        return {
          resource,
          response: { status: entry.request?.method === "PUT" ? "200 OK" : "201 Created" },
        };
      }),
    };
    return this.transactionResponseMutator?.(response) ?? response;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    if (resourceType === "Provenance") {
      if (params.target === this.provenancePageTarget && this.provenancePages) {
        return {
          resourceType: "Bundle",
          type: "searchset",
          entry: this.provenancePages[0]!.map((resource) => ({ resource: structuredClone(resource as T) })),
          ...(this.provenancePages.length > 1
            ? { link: [{ relation: "next", url: "/fhir/R4/Provenance?_page=2" }] }
            : {}),
        };
      }
      const rows = this.resources.filter((resource): resource is Provenance =>
        resource.resourceType === "Provenance" &&
        (!params.target || resource.target.some((target) => target.reference === params.target))
      );
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: rows.map((resource) => ({ resource: structuredClone(resource as T) })),
      };
    }
    if (resourceType !== "Encounter") throw new Error(`Unexpected search for ${resourceType}`);
    this.initialEncounterSearch = structuredClone(params);
    return this.encounterPage(["prior-1", "prior-2", "prior-3", "prior-4"], this.nextUrl);
  }

  async searchUrl<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>> {
    if (resourceType === "Provenance" && this.provenancePages) {
      this.followedUrls.push(url);
      const page = Number(new URL(url, "https://fhir.local").searchParams.get("_page"));
      const resources = this.provenancePages[page - 1] ?? [];
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: resources.map((resource) => ({ resource: structuredClone(resource as T) })),
        ...(page < this.provenancePages.length
          ? { link: [{ relation: "next", url: `/fhir/R4/Provenance?_page=${page + 1}` }] }
          : {}),
      };
    }
    if (resourceType !== "Encounter") throw new Error(`Unexpected paged search for ${resourceType}`);
    this.followedUrls.push(url);
    const failureStatus = this.searchUrlFailures.get(url);
    if (failureStatus) {
      throw Object.assign(new Error(`Synthetic FHIR ${failureStatus}`), { status: failureStatus });
    }
    if (url !== "/fhir/R4/Encounter?_page=2&_count=4") throw new Error(`Unexpected next URL ${url}`);
    return this.encounterPage(["prior-5"]);
  }

  private encounterPage<T extends Resource>(ids: string[], next?: string): Bundle<T> {
    const rows = ids.map((id) => this.resources.find((resource) =>
      resource.resourceType === "Encounter" && resource.id === id
    ) as T);
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: structuredClone(resource) })),
      ...(next ? { link: [{ relation: "next", url: next }] } : {}),
    };
  }
}
